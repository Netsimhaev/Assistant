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
function recording(): { sent: MailMessage[]; registry: AdapterRegistry } {
  const sent: MailMessage[] = [];
  const adapter = createMailAdapter({
    system: 'office-mail',
    transport: {
      async send(message) {
        sent.push(message);
        return { messageId: 'MSG-1' };
      },
    },
  });
  return { sent, registry: new AdapterRegistry([adapter], [browserAdapter]) };
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
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['a@b.com']);
  });

  it('hands the adapter the redacted payload, not the one the plan proposed', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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

  it('refuses the step when the binding is not live, after the gate has run', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
    expect((await loadJob(job.jobId, { businessId: BUSINESS }))?.phase).toBe('failed');
  });

  it('refuses when the binding names a credential the source cannot resolve', async () => {
    const bundle = await installCharter(buildCharter({ connections: [MAIL_CONNECTION] }), {
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
