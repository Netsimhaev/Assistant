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
import { queryAudit } from '../audit/log.js';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import type { ApprovalNotifier } from '../governance/notify.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import type { Plan } from '../domain/plan.js';
import type { PlanOutcome, PlanRequest } from '../sdk/planner.js';
import type { GatewayHealth, NormalizedInboundMessage, WhatsAppGateway } from '../whatsapp/gateway.js';
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
const HEALTH_FAIL_BUSINESS = 'test-business-health-fail';
const HEALTH_READ_FAIL_BUSINESS = 'test-business-health-read-fail';
const DOOR_THROWS_BUSINESS = 'test-business-door-throws';
const STALE_CHARTER_BUSINESS = 'test-business-no-charter';
const ONCE_PER_OUTAGE_BUSINESS = 'test-business-health-once-per-outage';
const NO_SENDALERT_BUSINESS = 'test-business-health-no-sendalert';
const PROBE_THROW_MID_OUTAGE_BUSINESS = 'test-business-health-probe-throw-mid-outage';
const DOWN_AT_BOOT_BUSINESS = 'test-business-health-down-at-boot';
const WORSENING_WORD_BUSINESS = 'test-business-health-worsening-word';
const HEALTH_HANG_BUSINESS = 'test-business-health-hang';
const DISTINCT_BODY_BUSINESS = 'test-business-health-distinct-body';
const SAME_INSTANT_BUSINESS = 'test-business-health-same-instant';
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

/**
 * A plan of reads only. Since the boss command (spec 2026-10-28, §10.4), a
 * plan with a classified step parks on a confirmation question and does not
 * run in the pass it was instructed in; this one runs, closes and is
 * reported in the same pass, which is what the ordering test below needs.
 */
const plannedWithRecallPlan = async (_request: PlanRequest): Promise<PlanOutcome> => ({
  status: 'planned',
  plan: {
    goal: 'להיזכר',
    assumptions: [],
    clarifyingQuestion: null,
    estimatedCostMinor: 0,
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'להיזכר',
        toolName: 'memory.recall',
        input: { subjectKey: 'dana@example.com' },
        dependsOn: [],
        expectedActionClass: null,
      },
    ],
  },
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

/**
 * Like `recordingNotifier`, but `failNext()` makes the NEXT `sendAlert` call
 * resolve `{ ok: false }` instead of `{ ok: true }` — for fix round 1's F1
 * (a failed send must be recorded, and must not consume the transition).
 */
function controllableNotifier(): {
  calls: { subject: string; body: string }[];
  notify: Runtime['notify'];
  failNext: () => void;
} {
  const calls: { subject: string; body: string }[] = [];
  let shouldFail = false;
  const notifier: ApprovalNotifier = {
    channel: 'email',
    async notify() {
      return { ok: true };
    },
  };
  return {
    calls,
    failNext() {
      shouldFail = true;
    },
    notify: {
      notifier,
      dashboardBaseUrl: 'http://127.0.0.1:8787',
      async sendAlert(subject, body) {
        calls.push({ subject, body });
        if (shouldFail) {
          shouldFail = false;
          return { ok: false, error: 'fake SMTP outage' };
        }
        return { ok: true };
      },
    },
  };
}

/** Every `whatsapp_health_notify_failed` incident row for this business, oldest first (`queryAudit`'s own order is newest-first). */
async function whatsappHealthIncidents(businessId: string): Promise<string[]> {
  const rows = await queryAudit({ businessId, kind: 'incident' });
  return rows
    .filter((row) => row.reason.startsWith('whatsapp_health_notify_failed'))
    .map((row) => row.reason)
    .reverse();
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
      // Reads only: a mail plan now waits for the owner's confirmation and
      // would not run in this pass (boss command, spec §4). The ordering
      // under test — door, run, close, report — is the same either way.
      whatsappPlanner: plannedWithRecallPlan,
    });

    expect(pass.whatsappError).toBeNull();
    expect(pass.whatsappDoor?.instructed).toBe(1);
    expect(pass.due.ran).toHaveLength(1); // ran in the SAME pass
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

  /**
   * Fix round 1, F1 — a failed send must be RECORDED (an `incident` audit
   * row), and the transition must NOT be marked handled just because an
   * attempt was made. Both are checked: the failed pass writes exactly one
   * row naming the failure, and the very next pass — still disconnected —
   * tries again rather than treating the outage as already reported.
   */
  it('records a failed health-alert send as an incident, and retries the next pass', async () => {
    await installCharter(buildCharter(), { businessId: HEALTH_FAIL_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify, failNext } = controllableNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline, no transition yet.
    await schedulerPass({ businessId: HEALTH_FAIL_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — the bridge drops, and the send fails.
    gateway.setHealth({ state: 'reconnecting', since: NOON.toISOString() });
    failNext();
    await schedulerPass({ businessId: HEALTH_FAIL_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1); // the attempt was made

    const incidents = (await queryAudit({ businessId: HEALTH_FAIL_BUSINESS, kind: 'incident' })).filter((row) =>
      row.reason.startsWith('whatsapp_health_notify_failed'),
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.reason).toContain('fake SMTP outage');

    // Pass 3 — still disconnected, and this time delivery succeeds. If the
    // failed attempt had been treated as "handled", this would stay at 1.
    await schedulerPass({ businessId: HEALTH_FAIL_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(2); // retried, not swallowed
  });

  /** Fix round 1, F6 — a flaky health PROBE must not refuse the owner's own instruction. */
  it('runs the door even when gateway.health() itself throws', async () => {
    await installCharter(buildCharter(), { businessId: DOOR_THROWS_BUSINESS });
    const gateway = createFakeGateway();
    gateway.health = (): Promise<never> => {
      throw new Error('health probe timed out');
    };
    gateway.enqueue(principalMessage('תשלחי לדנה'));

    const pass = await schedulerPass({
      businessId: DOOR_THROWS_BUSINESS,
      now: NOON,
      inbox: null,
      runtime: {
        registry: new AdapterRegistry([]),
        credentials: envCredentials({}, PREFIX),
        warnings: [],
        whatsapp: { gateway },
      },
      whatsappPlanner: plannedWithMailPlan,
    });

    expect(pass.whatsappError).toBeNull();
    expect(pass.whatsappDoor?.instructed).toBe(1);
  });

  /**
   * Fix round 1, F5 — `whatsappMessenger = null` in the catch is what makes
   * a door failure skip the report too. This is the one path the earlier
   * "no active charter" test could not cover: here the charter loads fine
   * and the messenger IS built, but `runWhatsAppDoor` itself throws
   * (`pollOnce` rejecting, the same shape a real gateway's HTTP poll can
   * fail with). Deleting the `= null` line leaves `whatsappReport` non-null
   * here, because the report guard would then see a stale, already-built
   * messenger as proof the door succeeded.
   */
  it('skips the report too when runWhatsAppDoor itself throws after the messenger was built', async () => {
    await installCharter(buildCharter(), { businessId: HEALTH_READ_FAIL_BUSINESS });
    const throwingGateway: WhatsAppGateway = {
      async canSendFreeform() {
        return true;
      },
      async sendMessage() {
        return { messageId: 'x', state: 'sent' };
      },
      async health() {
        return { state: 'connected', since: NOON.toISOString() };
      },
      onInbound() {
        // Never actually registered against, because `pollOnce` throws
        // before using it.
      },
      async pollOnce(): Promise<number> {
        throw new Error('pollOnce exploded');
      },
    };

    const pass = await schedulerPass({
      businessId: HEALTH_READ_FAIL_BUSINESS,
      now: NOON,
      inbox: null,
      runtime: {
        registry: new AdapterRegistry([]),
        credentials: envCredentials({}, PREFIX),
        warnings: [],
        whatsapp: { gateway: throwingGateway },
      },
    });

    expect(pass.whatsappError).not.toBeNull();
    expect(pass.whatsappDoor).toBeNull();
    expect(pass.whatsappReport).toBeNull();
  });

  /**
   * Fix round 2, item 3 (and the ruling's own failure mode) — the audit row
   * is written ONCE per outage, not once per retry pass: retries of the
   * SAME outage (same `since`) must not add a second row. And a genuinely
   * NEW outage — even one reporting the IDENTICAL state word as the first,
   * and even one that arrives WITHOUT this process ever observing a
   * `'connected'` state in between (the realistic shape of F6: this exact
   * probe missed the brief reconnect) — must still earn a row of its own.
   * That second half is exactly what discriminating by `health.since`
   * rather than the state word buys, and it is deliberately tested WITHOUT
   * an intervening reconnect: a design that cleared its bookkeeping only on
   * an OBSERVED reconnect would still pass a version of this test that goes
   * through one, which is why this one does not.
   */
  it('writes one incident per outage — not one per retry — and a second outage gets its own row even with the same state word and no observed reconnect in between', async () => {
    await installCharter(buildCharter(), { businessId: ONCE_PER_OUTAGE_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify, failNext } = controllableNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: ONCE_PER_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — outage 1 begins (since = T1); the send fails.
    const t1 = NOON.toISOString();
    gateway.setHealth({ state: 'reconnecting', since: t1 });
    failNext();
    await schedulerPass({ businessId: ONCE_PER_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(await whatsappHealthIncidents(ONCE_PER_OUTAGE_BUSINESS)).toHaveLength(1);

    // Pass 3 — still outage 1 (same `since`), the send fails again. Retried,
    // but NOT a second row.
    failNext();
    await schedulerPass({ businessId: ONCE_PER_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(2);
    expect(await whatsappHealthIncidents(ONCE_PER_OUTAGE_BUSINESS)).toHaveLength(1);

    // Pass 4 — still outage 1, this time delivery succeeds. Still no second row.
    await schedulerPass({ businessId: ONCE_PER_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(3);
    expect(await whatsappHealthIncidents(ONCE_PER_OUTAGE_BUSINESS)).toHaveLength(1);

    // Pass 5 — outage 2 begins DIRECTLY (since = T2, DIFFERENT from T1, but
    // the IDENTICAL state word 'reconnecting') — no `'connected'` state was
    // ever reported in between. Must still be read as genuinely new.
    const t2 = new Date(NOON.getTime() + 2).toISOString();
    gateway.setHealth({ state: 'reconnecting', since: t2 });
    failNext();
    await schedulerPass({ businessId: ONCE_PER_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(4);
    expect(await whatsappHealthIncidents(ONCE_PER_OUTAGE_BUSINESS)).toHaveLength(2);
  });

  /**
   * Fix round 2, item 2 — the `sendAlert === undefined` branch (no SMTP
   * configured at all) must not consume the transition either: the review
   * named this as the untested half of the same finding the `{ ok: false }`
   * path already covered in round 1. An operator who configures SMTP mid-
   * outage must still get told about the outage that was already underway.
   */
  it('does not consume the transition when no sendAlert is configured, and sends once one becomes available', async () => {
    await installCharter(buildCharter(), { businessId: NO_SENDALERT_BUSINESS });
    const gateway = createFakeGateway();
    const calls: { subject: string; body: string }[] = [];
    const notifier: ApprovalNotifier = {
      channel: 'email',
      async notify() {
        return { ok: true };
      },
    };
    // No `sendAlert` key at all — the exact shape of an installation with no
    // SMTP configured (`buildRuntime` never sets it in that case).
    const mutableNotify: NonNullable<Runtime['notify']> = {
      notifier,
      dashboardBaseUrl: 'http://127.0.0.1:8787',
    };
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      notify: mutableNotify,
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: NO_SENDALERT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — the bridge drops; nothing can be sent.
    gateway.setHealth({ state: 'reconnecting', since: NOON.toISOString() });
    await schedulerPass({ businessId: NO_SENDALERT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(0);
    expect(await whatsappHealthIncidents(NO_SENDALERT_BUSINESS)).toHaveLength(1);

    // Pass 3 — still no `sendAlert`, same outage. Must NOT write a second row.
    await schedulerPass({ businessId: NO_SENDALERT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(await whatsappHealthIncidents(NO_SENDALERT_BUSINESS)).toHaveLength(1);

    // The operator fixes SMTP mid-run — `sendAlert` becomes available on the
    // SAME `notify` object `baseRuntime` already carries.
    mutableNotify.sendAlert = async (subject, body) => {
      calls.push({ subject, body });
      return { ok: true };
    };

    // Pass 4 — still the same outage (same `since`). Must now be delivered —
    // the earlier unconfigured passes must not have been treated as "handled".
    await schedulerPass({ businessId: NO_SENDALERT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);
    expect(await whatsappHealthIncidents(NO_SENDALERT_BUSINESS)).toHaveLength(1);
  });

  /**
   * Fix round 2, item 4 — F6's own test proves the door still runs when
   * `health()` throws, but not that the health BOOKKEEPING survives
   * untouched. A catch that cleared `lastWhatsAppHealth` instead of simply
   * returning would pass that test unchanged while silently resetting the
   * outage this process already knows about and already wrote one row for
   * — which would make the NEXT retry of the SAME outage look like a brand
   * new one and write a second row. This test drives exactly that sequence.
   */
  it('leaves the health record untouched when the probe throws mid-outage, so a later retry is not mistaken for a new outage', async () => {
    await installCharter(buildCharter(), { businessId: PROBE_THROW_MID_OUTAGE_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify, failNext } = controllableNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: PROBE_THROW_MID_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — the outage begins; the send fails. One row.
    const since = NOON.toISOString();
    gateway.setHealth({ state: 'reconnecting', since });
    failNext();
    await schedulerPass({ businessId: PROBE_THROW_MID_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(await whatsappHealthIncidents(PROBE_THROW_MID_OUTAGE_BUSINESS)).toHaveLength(1);

    // Pass 3 — the PROBE itself throws (not the send). Must be a total no-op.
    gateway.health = (): Promise<never> => {
      throw new Error('probe flaked mid-outage');
    };
    await schedulerPass({ businessId: PROBE_THROW_MID_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1); // no send attempt was even made this pass

    // Pass 4 — the probe recovers, SAME outage, and this time delivery
    // succeeds. If pass 3 had reset the bookkeeping, this would be read as a
    // brand-new outage and write a SECOND row.
    gateway.health = async () => ({ state: 'reconnecting', since });
    await schedulerPass({ businessId: PROBE_THROW_MID_OUTAGE_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(2);
    expect(await whatsappHealthIncidents(PROBE_THROW_MID_OUTAGE_BUSINESS)).toHaveLength(1);
  });

  /**
   * Fix round 3, item 1 — rounds 1 and 2 both treated the very first
   * observation ever made for a business as never a transition, on the
   * theory that there is no prior `'connected'` state to have left. That
   * theory hid a real silence: an installation that boots — or restarts
   * mid-outage — with the bridge already down got zero emails and zero
   * audit rows for that outage, for as long as it stayed down, across any
   * number of restarts. The owner's interest in "the bridge is down, and
   * the process just started" is identical to his interest in "the bridge
   * just went down" — so the very first `health()` this process ever makes
   * for a business must alert if it is not `'connected'`.
   */
  it('alerts on the very first observation ever made, when the bridge is already down', async () => {
    await installCharter(buildCharter(), { businessId: DOWN_AT_BOOT_BUSINESS });
    const gateway = createFakeGateway();
    gateway.setHealth({ state: 'reconnecting', since: NOON.toISOString() });
    const { calls, notify } = recordingNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // The VERY FIRST pass this process ever runs for this business — no
    // prior record exists at all — and the bridge is already down.
    await schedulerPass({ businessId: DOWN_AT_BOOT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);
  });

  /**
   * Fix round 3, item 2 — keying by `since` alone left a gap the re-review
   * found by trying to break it: a gateway that holds the SAME `since`
   * while the state word WORSENS (`'reconnecting'` → `'banned'`) produced
   * no further row and no further email under round 2's design, because
   * `since` alone matched and the "already told, nothing new" shortcut
   * fired — so the owner was never told his bridge reached `'banned'`, the
   * single worst state it can be in. Keying by the pair `(since, state)`
   * instead means ANY change to the word under an unchanged `since` is read
   * as a new episode in its own right.
   */
  it('escalates to a new alert when the state word worsens under an unchanged since, even with no reconnect observed', async () => {
    await installCharter(buildCharter(), { businessId: WORSENING_WORD_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify } = recordingNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: WORSENING_WORD_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — the outage begins as 'reconnecting' (since = T1), delivered.
    const since = NOON.toISOString();
    gateway.setHealth({ state: 'reconnecting', since });
    await schedulerPass({ businessId: WORSENING_WORD_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);

    // Pass 3 — SAME `since`, but the word worsens to 'banned'. Must alert
    // again — this is a materially different, more serious fact, not a
    // retry of something already told.
    gateway.setHealth({ state: 'banned', since });
    await schedulerPass({ businessId: WORSENING_WORD_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toContain('banned');
  });

  /**
   * Fix round A, finding 3. `gateway.health()` is raced against
   * `HEALTH_CHECK_TIMEOUT_MS` (5s) instead of awaited directly. Before this
   * round, nothing made a wedged PROBE throw at all — F6's own test above
   * ("runs the door even when gateway.health() itself throws") proves the
   * `catch` tolerates a throw, but a probe that never settles never reached
   * that `catch`, and froze `schedulerPass`'s whole sequential await chain
   * (the door, every due plan, every close) for as long as it hung.
   * `HEALTH_CHECK_TIMEOUT_MS` is small enough to wait out for real, the
   * same way `messenger.test.ts` waits out the 5s `SEND_TIMEOUT_MS` rather
   * than overriding it — no test-only override exists for this private
   * function's constant, and none is needed at 5s.
   */
  it('does not hang the whole scheduler pass when gateway.health() never settles', async () => {
    await installCharter(buildCharter(), { businessId: HEALTH_HANG_BUSINESS });
    const gateway = createFakeGateway();
    gateway.health = (): Promise<GatewayHealth> => new Promise<never>(() => {
      /* deliberately never settles */
    });
    gateway.enqueue(principalMessage('תשלחי לדנה'));

    const started = Date.now();
    const pass = await schedulerPass({
      businessId: HEALTH_HANG_BUSINESS,
      now: NOON,
      inbox: null,
      runtime: {
        registry: new AdapterRegistry([]),
        credentials: envCredentials({}, PREFIX),
        warnings: [],
        whatsapp: { gateway },
      },
      whatsappPlanner: plannedWithMailPlan,
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(9_000);
    // The door still ran this pass — a wedged health PROBE must not refuse
    // the owner's own instruction, the same property F6's throw test
    // already pins, now proven for a HANG rather than a throw.
    expect(pass.whatsappError).toBeNull();
    expect(pass.whatsappDoor?.instructed).toBe(1);
  }, 15_000);

  /**
   * Fix round A, finding 1 — the alert BODY, not just the in-memory health
   * record, must distinguish between two outages that happen to share a
   * state word. `sendAlert`'s real idempotency key (`runtime.ts`) is
   * `canonicalHash({ subject, body })`; before this round `body` carried
   * `current.state` but not `current.since`, so two genuinely distinct
   * outages under the same word hashed to the IDENTICAL key — the real
   * transport would mint the same Message-ID twice, the receiving server
   * would read the second as a duplicate of the first, and `sendAlert`
   * still returns `{ ok: true }` either way. A test counting `sendAlert`
   * calls (as every other test in this file does) cannot see that at all —
   * this asserts on the BODY TEXT a real transport would hash instead.
   */
  it('gives two outages sharing a state word different alert bodies, and the same outage retried an identical one', async () => {
    await installCharter(buildCharter(), { businessId: DISTINCT_BODY_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify, failNext } = controllableNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: DISTINCT_BODY_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — outage 1 begins (since = T1, state = 'reconnecting'); the
    // send fails, so a retry of the SAME outage happens on pass 3.
    const t1 = NOON.toISOString();
    gateway.setHealth({ state: 'reconnecting', since: t1 });
    failNext();
    await schedulerPass({ businessId: DISTINCT_BODY_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);

    // Pass 3 — still outage 1 (same `since`, same word), delivery succeeds.
    // This is a RETRY of the SAME outage — the body must be byte-identical
    // to pass 2's, or a real transport would (correctly) refuse to treat it
    // as a duplicate and the owner would get a second email for one outage.
    await schedulerPass({ businessId: DISTINCT_BODY_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);

    // Pass 4 — reconnect, to close out outage 1 cleanly.
    gateway.setHealth({ state: 'connected', since: new Date(NOON.getTime() + 1).toISOString() });
    await schedulerPass({ businessId: DISTINCT_BODY_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 5 — outage 2 begins, with the IDENTICAL state word 'reconnecting'
    // but a DIFFERENT `since`. This must produce a DIFFERENT body than
    // outage 1's — the exact property that was missing before this fix.
    const t2 = new Date(NOON.getTime() + 2).toISOString();
    gateway.setHealth({ state: 'reconnecting', since: t2 });
    await schedulerPass({ businessId: DISTINCT_BODY_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).not.toBe(calls[0]?.body);
  });

  /**
   * Fix round B, finding 2. The health RECORD keyed on the raw `since`
   * string the gateway returned; the alert BODY formatted it through
   * `new Date(...)`, which normalises its input for display only. Two ISO
   * spellings of the SAME instant (`…T09:00:00.000Z` and
   * `…T12:00:00.000+03:00`, three hours and two milliseconds apart in
   * clock-face terms, zero apart in wall-clock terms) therefore disagreed
   * with themselves: the raw-string record comparison read the second
   * spelling as a genuinely NEW episode (strings differ) and tried to send
   * a second alert, while the DISPLAY — built from the same underlying
   * instant — rendered byte-identical to the first alert's. A real SMTP
   * transport, hashing that identical body into the identical Message-ID,
   * would have dropped the "new" alert as a duplicate of the first — this
   * process believing it told the owner about a second outage that the
   * mailer silently never delivered. Normalising `since` once, before
   * either consumer touches it, means the two can no longer disagree: this
   * must read as the SAME episode on both sides, producing no second call
   * at all — not a second call with a colliding body.
   */
  it('reads two ISO spellings of the identical instant as the same episode, not a new one with a colliding body', async () => {
    await installCharter(buildCharter(), { businessId: SAME_INSTANT_BUSINESS });
    const gateway = createFakeGateway();
    const { calls, notify } = recordingNotifier();
    const baseRuntime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      warnings: [],
      whatsapp: { gateway },
      ...(notify !== undefined ? { notify } : {}),
    };

    // Pass 1 — connected baseline.
    await schedulerPass({ businessId: SAME_INSTANT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });

    // Pass 2 — the outage begins, `since` spelled in UTC `Z` form.
    gateway.setHealth({ state: 'reconnecting', since: '2026-08-18T09:00:00.000Z' });
    await schedulerPass({ businessId: SAME_INSTANT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);

    // Pass 3 — the SAME outage, same literal instant, spelled with an
    // explicit `+03:00` offset instead of `Z`. Must be read as the SAME
    // episode — no second call, not a second call with a duplicate body.
    gateway.setHealth({ state: 'reconnecting', since: '2026-08-18T12:00:00.000+03:00' });
    await schedulerPass({ businessId: SAME_INSTANT_BUSINESS, now: NOON, inbox: null, runtime: baseRuntime });
    expect(calls).toHaveLength(1);
  });
});
