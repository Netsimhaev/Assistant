import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createJob, jobHistory, loadJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { browserAdapter } from './adapters/browser.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import type { AdapterCall, AdapterResult, ExternalAdapter } from './adapters/types.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import type { CredentialSource } from './credentials.js';
import { createCredentialHandle } from './adapters/types.js';
import { runPlan, runPlanForJob } from './run-plan.js';

const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const PREFIX = 'TEST_CRED_';

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

/**
 * Every charter in this file declares `knownCounterpartyEmailDomain: 'b.com'`,
 * matching the `a@b.com` these plans address.
 *
 * It is load-bearing. Since the first-contact exempt set was emptied (10/09),
 * a `boss` chain no longer skips the escalation for a recipient the charter
 * cannot resolve — such a send scores `one_unknown`, the band comes out
 * `sensitive`, and the step queues an approval. This file is about what
 * happens once a step actually reaches an adapter: the endpoint that travels
 * with it, the redacted payload it carries, retryable versus final failures,
 * the deadline. None of that is observable on a step that never dispatches.
 */
const LIVE: ConnectionBinding = {
  system: 'office-mail',
  status: 'live',
  endpoint: null,
  credentialRef: 'OFFICE_MAIL',
  lastOkAt: null,
  lastError: null,
};

const CREDENTIALS = envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX);

/**
 * A mail adapter over a transport that records instead of sending, plus the
 * browser driver as the browser channel's default. Nothing in this suite ever
 * opens a socket.
 */
function recording(): {
  sent: MailMessage[];
  endpoints: (string | null)[];
  registry: AdapterRegistry;
} {
  const sent: MailMessage[] = [];
  const endpoints: (string | null)[] = [];
  const adapter = createMailAdapter({
    system: 'office-mail',
    transport: {
      async send(message, context) {
        sent.push(message);
        endpoints.push(context.endpoint);
        return { messageId: 'MSG-1' };
      },
    },
  });
  return { sent, endpoints, registry: new AdapterRegistry([adapter], [browserAdapter]) };
}

function mailPlan(): Plan {
  return Plan.parse({
    goal: 'לענות ללקוח',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply',
        toolName: 'mail.send',
        input: {
          to: 'a@b.com',
          inReplyTo: 'm1',
          counterpartyId: 'c_812',
          subject: 'שלום',
          body: 'מספר 123456789',
        },
      },
    ],
  });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('a plan reaches a real external system', () => {
  it('sends through the adapter the registry resolved', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['a@b.com']);
    // The provider's handle on what was created. Without it `verify` has no
    // way to ask the far end what actually happened.
    expect(result.steps[0]?.externalId).toBe('MSG-1');
  });

  it('carries the binding endpoint through to the transport', async () => {
    // `endpoint` is validated on write and audited as a trust-relocating
    // change. Until it reached the transport, that audit entry described a
    // field nothing read.
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { endpoints, registry } = recording();

    await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [{ ...LIVE, endpoint: 'smtp://mail.example.co.il:587' }],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(endpoints).toEqual(['smtp://mail.example.co.il:587']);
  });

  it('hands the adapter the redacted payload, not the one the plan proposed', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // The charter redacts a bare nine-digit number. The adapter must never see
    // the original.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).not.toContain('123456789');
    expect(sent[0]?.body).toContain('[הוסר]');
  });

  it('loads the bindings from the store when nobody injects them', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    await upsertBinding(LIVE, { businessId: BUSINESS, by: 'p_boss' });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlanForJob({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);
  });

  it('rejects the whole plan when the charter declares no channel for a tool', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // Refusal, not a fall back to the browser: an unknown system reached by
    // falling back is exactly the route an attacker would choose.
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('no_channel_for_tool');
    expect(sent).toEqual([]);
    // Rejected before anything ran: the job never left `execute`.
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('execute');
  });

  it('rejects a whole multi-step plan on the LAST step lacking a channel', async () => {
    // The step without a channel is the second one. A plan validated lazily
    // would have sent the first mail before discovering it.
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: Plan.parse({
        goal: 'לענות ואז לעדכן',
        steps: [
          {
            id: 's1',
            agent: 'comms.email',
            intent: 'reply',
            toolName: 'mail.send',
            input: { to: 'a@b.com', inReplyTo: 'm1', counterpartyId: 'c_812', subject: 'ש', body: 'ג' },
          },
          {
            id: 's2',
            agent: 'ops.systems',
            intent: 'update_record',
            toolName: 'crm.write',
            input: { entityId: 'c_812' },
            dependsOn: ['s1'],
          },
        ],
      }),
      registry,
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('s2');
    expect(result.reason).toContain('no_channel_for_tool');
    expect(sent).toEqual([]);
  });

  it('rejects a declared connection that no adapter implements', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [{ ...MAIL_CONNECTION, system: 'ghost-mail' }] }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [{ ...LIVE, system: 'ghost-mail' }],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('no_adapter_for_system');
    expect(sent).toEqual([]);
  });

  it('sleeps the job when the adapter says the failure is retryable', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const failing = createMailAdapter({
      system: 'office-mail',
      transport: {
        async send() {
          // The shape a real SMTP client throws: a network code, not a reply.
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      },
    });

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry: new AdapterRegistry([failing], [browserAdapter]),
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    const after = await loadJob(job.jobId, { businessId: BUSINESS });
    // Back to followup with a wake time — the loop the scheduler already runs.
    expect(after?.phase).toBe('followup');
    expect(after?.wakeAt).not.toBeNull();
  });

  it('sleeps the step when the binding is not live, after the gate has run', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [{ ...LIVE, status: 'disconnected' }],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    expect(sent).toEqual([]);

    // Not rejected at validation: the step reached the gate, and the failure
    // is on the record rather than having vanished with the plan.
    const history = await jobHistory(job.jobId);
    expect(history.some((h) => h.reason.includes('channel_unavailable'))).toBe(true);

    // A binding that is down is transient — it may be live again in five
    // minutes — so the job sleeps to followup rather than failing terminally
    // and throwing away work that nothing was wrong with.
    const after = await loadJob(job.jobId, { businessId: BUSINESS });
    expect(after?.phase).toBe('followup');
    expect(after?.wakeAt).not.toBeNull();
  });

  it('refuses when the binding names a credential the source cannot resolve', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: envCredentials({}, PREFIX),
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.reason).toBe('credential_unavailable');
    expect(sent).toEqual([]);
  });
});

/**
 * `CredentialSource.resolve` takes the business as a REQUIRED second argument
 * with no default anywhere on the path, and `runPlan` is its only production
 * caller — it holds `job.businessId` and passes it on. Nothing observed that
 * until this stub existed.
 *
 * **This is the finding, and it is worth the docblock.** Every other test in
 * this file — and in `run-due`, `ramp-raise`, `scheduler-runs-plans` and
 * `resume-plan` — injects `envCredentials`, whose `resolve` takes
 * `_businessId` and ignores it by construction: it reads one shared process
 * environment with no per-business partition at all. So replacing
 * `request.job.businessId` in `run-plan.ts` with a wrong literal felled zero
 * of forty-six tests. A signature that cannot be observed is a signature
 * nothing holds up, and the same shape already bit this branch once, where a
 * test for the query's business filter was in fact being satisfied by the
 * cipher's AAD binding.
 *
 * So this source records what it was asked for and answers everything. The
 * assertion is the pass-through itself: the business the step resolved under
 * is the business on the job's own row, not a default and not another
 * customer's.
 */
function recordingCredentials(): {
  calls: { ref: string; businessId: string }[];
  source: CredentialSource;
} {
  const calls: { ref: string; businessId: string }[] = [];
  return {
    calls,
    source: {
      async resolve(ref: string, businessId: string) {
        calls.push({ ref, businessId });
        return createCredentialHandle(ref, 'pw');
      },
    },
  };
}

describe("a credential is resolved under the job's own business", () => {
  it("passes the job's businessId to the credential source, not a default", async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);
    const { sent, registry } = recording();
    const { calls, source } = recordingCredentials();

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry,
      bindings: [LIVE],
      credentials: source,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    // The step must actually have run. A plan the gate refused earlier would
    // resolve no credential at all, and `calls` would be empty for a reason
    // that has nothing to do with what this test claims to cover — the
    // negative-test trap this project has been bitten by three times.
    expect(result.status).toBe('done');
    expect(sent).toHaveLength(1);

    expect(calls).toEqual([{ ref: 'OFFICE_MAIL', businessId: job.businessId }]);
    // Named explicitly, so a future change to the fixture's business id
    // cannot quietly make the line above compare two defaults to each other.
    expect(job.businessId).toBe(BUSINESS);
  });
});

describe('only a step that goes somewhere needs a channel', () => {
  it('runs a plan of purely local steps with no connections and an empty registry', async () => {
    // `crm.read`, `memory.recall` and `escalate_to_human` reach nothing
    // outside the instance. Demanding a signed connection for them rejected
    // plans the planner's own catalogue says are valid.
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: Plan.parse({
        goal: 'להבין את המצב לפני שעונים',
        steps: [
          { id: 's1', agent: 'ops.systems', intent: 'read', toolName: 'crm.read', input: { entityId: 'c_812' } },
          {
            id: 's2',
            agent: 'ops.systems',
            intent: 'recall',
            toolName: 'memory.recall',
            input: { query: 'c_812' },
            dependsOn: ['s1'],
          },
        ],
      }),
      registry: new AdapterRegistry([]),
      bindings: [],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('unreachable');
    expect(result.steps.map((record) => record.stepId)).toEqual(['s1', 's2']);
    // Nothing was created anywhere, so there is no external handle to record.
    expect(result.steps.map((record) => record.externalId)).toEqual([null, null]);
  });

  it('still demands a channel for the outbound step in a mostly-local plan', async () => {
    const bundle = await installCharter(buildCharter(), { businessId: BUSINESS });
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: Plan.parse({
        goal: 'לקרוא ואז לענות',
        steps: [
          { id: 's1', agent: 'ops.systems', intent: 'read', toolName: 'crm.read', input: {} },
          {
            id: 's2',
            agent: 'comms.email',
            intent: 'reply',
            toolName: 'mail.send',
            input: { to: 'a@b.com', inReplyTo: 'm1', subject: 'ש', body: 'ג' },
            dependsOn: ['s1'],
          },
        ],
      }),
      registry: new AdapterRegistry([]),
      bindings: [],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('unreachable');
    expect(result.reason).toContain('s2');
    expect(result.reason).toContain('no_channel_for_tool');
  });
});

describe('the adapter deadline is enforced, not merely announced', () => {
  it('sleeps the job when an adapter never answers', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION], knownCounterpartyEmailDomain: 'b.com' }), {
      businessId: BUSINESS,
    });
    const job = await jobInExecute(bundle);

    // An adapter that ignores the AbortSignal entirely, which is the case the
    // signal alone cannot handle: nothing cancels a promise from outside.
    const hanging: ExternalAdapter = {
      system: 'office-mail',
      channel: 'api',
      serves: ['mail.send'],
      execute() {
        return new Promise<AdapterResult>(() => {
          /* never settles */
        });
      },
    };

    const result = await runPlan({
      job,
      bundle,
      plan: mailPlan(),
      registry: new AdapterRegistry([hanging]),
      bindings: [LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
      adapterTimeoutMs: 25,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.reason).toBe('deferred');

    const after = await loadJob(job.jobId, { businessId: BUSINESS });
    // Retryable: a call that timed out may or may not have landed, which is
    // exactly what the idempotency key is for.
    expect(after?.phase).toBe('followup');
    const history = await jobHistory(job.jobId);
    expect(history.some((h) => h.reason.includes('adapter_timeout'))).toBe(true);
  });
});

describe('a failed adapter is a failed step, not a completed one', () => {
  /** An adapter that always refuses, permanently. */
  function refusing(system: string, serves: readonly string[]): ExternalAdapter {
    return {
      system,
      channel: 'api',
      serves,
      async execute(_call: AdapterCall): Promise<AdapterResult> {
        return {
          ok: false,
          retryable: false,
          code: 'system_rejected',
          message: 'המערכת בצד השני דחתה את הבקשה',
        };
      },
    };
  }

  const BOOKS: CharterConnection = {
    system: 'books',
    label: 'הנהלת חשבונות',
    channel: 'api',
    serves: ['accounting.write'],
    target: null,
    subprocessor: null,
  };

  const BOOKS_LIVE: ConnectionBinding = {
    system: 'books',
    status: 'live',
    endpoint: null,
    credentialRef: null,
    lastOkAt: null,
    lastError: null,
  };

  function spendPlan(): Plan {
    return Plan.parse({
      goal: 'לרשום חיוב',
      steps: [
        {
          id: 's1',
          agent: 'ops.systems',
          intent: 'post_entry',
          toolName: 'accounting.write',
          input: { entityId: 'c_812', amountMinor: 50_000 },
        },
      ],
    });
  }

  it('records no spend and never reaches verify when the adapter refuses', async () => {
    const bundle = await installCharter(
      buildCharter({ connections: [BOOKS], autonomyBase: { 'accounting.write': 'auto' } }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: spendPlan(),
      registry: new AdapterRegistry([refusing('books', ['accounting.write'])]),
      bindings: [BOOKS_LIVE],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.reason).toBe('system_rejected');

    // Money that was never moved must not be on the ledger, and a step that
    // did not happen must not be waiting to be verified.
    const { rows } = await getPool().query('SELECT * FROM spend_ledger WHERE business_id = $1', [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(0);
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('treats the unbuilt browser driver as a refusal, not as a completed step', async () => {
    // The concrete regression this closes: `browserAdapter` returns
    // `browser_not_implemented`, and a runner that ignored the result would
    // have transitioned the job to `verify` as though the click had happened.
    //
    // Resolved through the browser CHANNEL DEFAULT, not by system name: no
    // charter ever names a system `browser`, so an adapter reachable only
    // under its own name would be unreachable here.
    const bundle = await installCharter(
      buildCharter({
        connections: [
          {
            system: 'supplier-a-portal',
            label: 'אתר ספק א',
            channel: 'browser',
            serves: ['browser.click'],
            target: null,
            subprocessor: null,
          },
        ],
      }),
      { businessId: BUSINESS },
    );
    const job = await jobInExecute(bundle);

    const result = await runPlan({
      job,
      bundle,
      plan: Plan.parse({
        goal: 'להתקדם בטופס אצל הספק',
        steps: [
          {
            id: 's1',
            agent: 'ops.web',
            intent: 'advance_form',
            toolName: 'browser.click',
            input: { supplierId: 'supplier_a', selector: '#next' },
          },
        ],
      }),
      registry: new AdapterRegistry([], [browserAdapter]),
      bindings: [
        {
          system: 'supplier-a-portal',
          status: 'live',
          endpoint: null,
          credentialRef: null,
          lastOkAt: null,
          lastError: null,
        },
      ],
      credentials: CREDENTIALS,
      counterpartyTags: [],
      rampLevel: 'auto',
      now: NOON,
    });

    expect(result.status).toBe('halted');
    if (result.status !== 'halted') throw new Error('unreachable');
    expect(result.reason).toBe('browser_not_implemented');
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });
});
