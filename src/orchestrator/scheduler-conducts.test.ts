import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { ingestDocument } from '../documents/ingest.js';
import type { CharterConnection } from '../domain/connection.js';
import { Plan } from '../domain/plan.js';
import type { Proposal } from '../domain/proposal.js';
import type { Reading } from '../domain/reading.js';
import { AdapterRegistry } from './adapters/registry.js';
import { createMailAdapter, type MailMessage } from './adapters/mail.js';
import { upsertBinding } from './bindings.js';
import { envCredentials } from './credentials.js';
import { createJob, loadJob, transition } from './jobs.js';
import { setAutonomyMode } from '../governance/autonomy-mode.js';
import { bindPlanToJob } from './plan-store.js';
import { setRampLevel } from './ramp.js';
import { schedulerPass } from './scheduler.js';
import type { Runtime } from './runtime.js';

const BUSINESS = 'biz-sched-conduct';
const PREFIX = 'TEST_CRED_';
// Fixed clock, matching scheduler-runs-plans.test.ts: an evening wall-clock
// run of this suite would otherwise fall inside quiet hours.
const NOON = new Date('2026-08-18T09:00:00.000Z');

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const PLAN: Plan = Plan.parse({
  goal: 'send one mail',
  steps: [
    {
      id: 's1',
      agent: 'comms.email',
      intent: 'send the confirmation',
      toolName: 'mail.send',
      // `counterpartyId: 'c_812'` matches the known counterparty `buildCharter`
      // always includes — without it the gate scores this `one_unknown` and
      // queues an approval regardless of autonomy or ramp.
      input: { to: 'dana@example.com', counterpartyId: 'c_812', subject: 'נושא', body: 'גוף' },
      expectedActionClass: 'email.initiate',
    },
  ],
});

// Same shape as `conduct.test.ts`'s own `READING`/`ACTING` fixtures — a
// stance that carries an action, so `conductPendingDocuments` raises a card.
const READING: Reading = {
  summary: 'חוזה שיווק עם ספק',
  findings: [{ label: 'מחיר', value: 'המחיר 4,000 ש"ח', sourceRef: { ordinal: 0, locator: null } }],
  intents: [
    {
      intent: 'reply_to_sender',
      subject: { kind: 'sender' },
      sourceRef: { ordinal: 0, locator: null },
      note: 'לאשר קבלה',
    },
  ],
  unreadable: [],
};

const ACTING: Proposal = {
  headline: 'קראתי את החוזה',
  stance: 'act',
  reasons: [{ text: 'המחיר תואם', findingLabel: 'מחיר', sourceRef: { ordinal: 0, locator: null } }],
  clarifyingQuestion: null,
  action: {
    headline: 'אשלח מייל לדנה',
    purpose: 'לאשר קבלה',
    agent: 'comms.email',
    intent: 'reply_to_sender',
    toolName: 'mail.send',
    expectedActionClass: 'email.initiate',
    input: { to: 'dana@example.com', subject: 'התקבל', body: 'תודה' },
  },
};

/**
 * `buildRuntime` reads the installation's master key file and refuses to
 * build without one, so a test that is not about the runtime passes an
 * explicit one rather than falling through to the lazy default — which would
 * now throw. Nothing in these passes resolves a credential; `runtimeWith` is
 * simply what "a runtime that is not the subject of this test" looks like.
 */
function runtimeWith(sent: MailMessage[]): Runtime {
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
  };
}

/** A job sitting in `execute` with a bound plan, ready for `runDueJobs` to run it. */
async function jobReadyToRun(charterVersion: string): Promise<string> {
  const job = await createJob({
    charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'run and close',
  });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  await upsertBinding(
    {
      system: 'office-mail',
      status: 'live',
      endpoint: null,
      credentialRef: 'OFFICE_MAIL',
      lastOkAt: null,
      lastError: null,
    },
    { businessId: BUSINESS, by: 'test' },
  );
  await bindPlanToJob(job.jobId, PLAN, { businessId: BUSINESS });
  // The owner's dial (Task 2) defaults to `off`, which clamps `loadRampLevel`
  // to `draft_only` regardless of what is stored — open it first so the
  // promotion below is actually honoured.
  await setAutonomyMode('learn', 'owner@example.com', { businessId: BUSINESS });
  await setRampLevel('email.initiate', 'auto', { businessId: BUSINESS });
  return job.jobId;
}

describe('schedulerPass and the conductor', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  it('scans the inbox when one is configured, into the given document root', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'sched-inbox-'));
    const documentRoot = await mkdtemp(join(tmpdir(), 'sched-root-'));
    await writeFile(join(inbox, 'note.txt'), 'שלום', 'utf8');

    const result = await schedulerPass({
      businessId: BUSINESS,
      inbox,
      documentRoot,
      runtime: runtimeWith([]),
      // No reader injected: the pass must not call a model in this test, so
      // the ceiling is set to zero and only the scan runs.
      readsPerDay: 0,
    });

    expect(result.scan?.ingested).toBe(1);
    expect(result.scanError).toBeNull();
    // The conductor's own loop ran too (forwarded from the same options),
    // and with the ceiling at zero it reports so rather than a hardcoded
    // zero result standing in for a call that never happened. `not.toBeNull`
    // first, and separately: `conduct` is now null when no inbox is
    // configured, and this is the half of I1's evidence that says a
    // configured inbox does still run it.
    expect(result.conduct).not.toBeNull();
    expect(result.conduct?.ceilingReached).toBe(true);

    const { rows } = await getPool().query<{ document_id: string; stored_path: string }>(
      `SELECT document_id, stored_path FROM documents WHERE business_id = $1`,
      [BUSINESS],
    );
    expect(rows).toHaveLength(1);
    // Proves `documentRoot` itself was forwarded through to `scanInbox` →
    // `ingestDocument`, not just that ingestion happened somewhere: the
    // bytes must land under the given root and nowhere else (`storedPath` is
    // relative, so this is the only way to catch a dropped conditional
    // spread landing the file under `config.documentRoot` instead).
    const row = rows[0];
    if (row === undefined) throw new Error('unreachable');
    await stat(join(documentRoot, row.stored_path));
  });

  it('runs neither loop, and does not fail, when no inbox is configured', async () => {
    // Makes its own precondition true rather than relying on `.env` happening
    // to leave `DOCUMENT_INBOX` unset — the shape the sibling test below
    // already used. The moment anyone actually configured the feature, the
    // earlier version of this test scanned a real folder and went red:
    // configuring the feature broke the suite.
    const mutableConfig = config as { documentInbox: string | null };
    const original = mutableConfig.documentInbox;
    mutableConfig.documentInbox = null;
    try {
      // Deliberately no `readsPerDay: 0`. The ceiling must not be what stops
      // the conductor here — the switch must. With the ceiling left at its
      // configured default, a regression that moved `conductPendingDocuments`
      // back outside the `inbox !== null` guard would return a real
      // `ConductResult` and fail the last assertion (I1).
      const result = await schedulerPass({ businessId: BUSINESS, runtime: runtimeWith([]) });
      expect(result.scan).toBeNull();
      expect(result.scanError).toBeNull();
      expect(result.conduct).toBeNull();
    } finally {
      mutableConfig.documentInbox = original;
    }
  });

  it('an explicit null inbox wins over a configured one', async () => {
    // Proves the ternary is `options.inbox !== undefined ? options.inbox :
    // config.documentInbox`, not a collapsing `options.inbox ?? ...` — the
    // latter treats an explicit `null` the same as "not passed" and would
    // fall through to the configured path here, actually scanning it.
    const configuredInbox = await mkdtemp(join(tmpdir(), 'sched-configured-inbox-'));
    const mutableConfig = config as { documentInbox: string | null };
    const original = mutableConfig.documentInbox;
    mutableConfig.documentInbox = configuredInbox;
    try {
      const result = await schedulerPass({
        businessId: BUSINESS,
        inbox: null,
        readsPerDay: 0,
        runtime: runtimeWith([]),
      });
      expect(result.scan).toBeNull();
      expect(result.scanError).toBeNull();
      // `scanInbox` creates its four working subdirectories as its first
      // act. None here means it was never called against this folder.
      expect(await readdir(configuredInbox)).toHaveLength(0);
    } finally {
      mutableConfig.documentInbox = original;
    }
  });

  it('a document actually read and carded through schedulerPass proves the forwarded reader/proposer reach the conductor', async () => {
    // Mirrors conduct.test.ts's own "takes a document all the way to a
    // pending card" — run through `schedulerPass` instead of
    // `conductPendingDocuments` directly, so a hardcoded zero `conduct`
    // result standing in for the real call would fail here: `carded` would
    // stay 0, `reads`/`proposals` would stay 0, and no approval row would
    // exist.
    const conductBusiness = 'biz-sched-conduct-2';
    await installCharter(buildCharter(), { businessId: conductBusiness });
    const dir = await mkdtemp(join(tmpdir(), 'sched-doc-'));
    const path = join(dir, 'doc.txt');
    await writeFile(path, 'חוזה שיווק', 'utf8');
    await ingestDocument(
      { path, source: 'manual' },
      { businessId: conductBusiness, documentRoot: dir },
    );

    let reads = 0;
    let proposals = 0;
    const reader = async () => {
      reads += 1;
      return { status: 'read' as const, reading: READING, raw: '{}', denials: [], turns: 1 };
    };
    const proposer = async () => {
      proposals += 1;
      return { status: 'proposed' as const, proposal: ACTING, raw: '{}' };
    };

    // An explicit (empty) inbox, not the ambient `config.documentInbox`: the
    // conductor runs only behind the same switch as the scan (I1), and a test
    // about the conductor must state that precondition itself rather than
    // inherit whatever `.env` happens to hold.
    const inbox = await mkdtemp(join(tmpdir(), 'sched-conduct-inbox-'));

    const result = await schedulerPass({
      businessId: conductBusiness,
      inbox,
      reader,
      proposer,
      runtime: runtimeWith([]),
    });

    expect(reads).toBe(1);
    expect(proposals).toBe(1);
    expect(result.conduct?.carded).toBe(1);
    const approvals = await getPool().query(
      `SELECT 1 FROM approval_requests ar
         JOIN jobs j ON j.job_id = ar.job_id
        WHERE j.business_id = $1`,
      [conductBusiness],
    );
    expect(approvals.rows).toHaveLength(1);
  });

  // I3, the wiring half: `conduct.test.ts` proves `raiseProposalApproval`
  // notifies when handed a notifier, but it hands it one directly. What that
  // cannot show — and what actually broke — is whether anything in production
  // ever hands it one. This runs the whole pass with a `Runtime` shaped
  // exactly as `buildRuntime` returns it, and fails if `schedulerPass` drops
  // `runtime.notify` on the way into the conductor.
  it('forwards the runtime notifier all the way to the conductor card', async () => {
    const notifyBusiness = 'biz-sched-conduct-notify';
    await installCharter(buildCharter(), { businessId: notifyBusiness });
    const dir = await mkdtemp(join(tmpdir(), 'sched-notify-doc-'));
    const path = join(dir, 'doc.txt');
    await writeFile(path, 'חוזה שיווק להתראה', 'utf8');
    await ingestDocument(
      { path, source: 'manual' },
      { businessId: notifyBusiness, documentRoot: dir },
    );

    const notified: string[] = [];
    const runtime: Runtime = {
      registry: new AdapterRegistry([]),
      credentials: envCredentials({}, PREFIX),
      notify: {
        notifier: {
          channel: 'email',
          async notify(request) {
            notified.push(request.approvalId);
            return { ok: true };
          },
        },
        dashboardBaseUrl: 'http://127.0.0.1:8787',
      },
      warnings: [],
    };

    const inbox = await mkdtemp(join(tmpdir(), 'sched-notify-inbox-'));
    const result = await schedulerPass({
      businessId: notifyBusiness,
      inbox,
      runtime,
      reader: async () => ({
        status: 'read' as const,
        reading: READING,
        raw: '{}',
        denials: [],
        turns: 1,
      }),
      proposer: async () => ({ status: 'proposed' as const, proposal: ACTING, raw: '{}' }),
    });

    expect(result.conduct?.carded).toBe(1);
    expect(notified).toHaveLength(1);
  });

  // Spec §11's headline safety case, end to end: a hostile file is rejected
  // by the scan and never reaches the half that costs money. `inbox-scan.test.ts`
  // holds the rejection and the folder it lands in; what only a full pass can
  // show is that the conductor made zero model calls because of it.
  it('a hostile file is rejected by the scan and costs nothing', async () => {
    const hostileBusiness = 'biz-sched-conduct-hostile';
    await installCharter(buildCharter(), { businessId: hostileBusiness });
    const inbox = await mkdtemp(join(tmpdir(), 'sched-hostile-inbox-'));
    const documentRoot = await mkdtemp(join(tmpdir(), 'sched-hostile-root-'));
    // A `.xlsx` name over bytes that begin as a ZIP and then are not one:
    // sniffed as a spreadsheet from the bytes, refused by the archive guard
    // before any extractor library sees the content.
    await writeFile(
      join(inbox, 'evil.xlsx'),
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip')]),
    );

    let reads = 0;
    let proposals = 0;
    const result = await schedulerPass({
      businessId: hostileBusiness,
      inbox,
      documentRoot,
      runtime: runtimeWith([]),
      // Both throw rather than return: nothing here should call them at all,
      // and a stub that returns something plausible would let a regression
      // continue quietly past the point this test exists to catch.
      reader: async () => {
        reads += 1;
        throw new Error('the reader must not be called for a rejected document');
      },
      proposer: async () => {
        proposals += 1;
        throw new Error('the proposer must not be called for a rejected document');
      },
    });

    expect(result.scan?.rejected).toBe(1);
    expect(result.scan?.ingested).toBe(0);
    expect(await readdir(join(inbox, 'rejected'))).toEqual(['evil.xlsx']);

    // The conductor ran — it is behind the same switch as the scan, and the
    // inbox is configured here, so `conduct` must not be null. It simply
    // found nothing to consider, because a rejected document never reaches
    // `status = 'extracted'`.
    expect(result.conduct).not.toBeNull();
    expect(result.conduct?.considered).toBe(0);
    expect(result.conduct?.carded).toBe(0);
    expect(reads).toBe(0);
    expect(proposals).toBe(0);
  });

  it('a broken inbox is recorded, not thrown, and the rest of the pass still runs', async () => {
    // A second version: `beforeEach` already installed one for `BUSINESS` at
    // the default `buildCharter()` version, and `charter_versions` refuses a
    // repeat.
    const bundle = await installCharter(
      buildCharter({
        version: '2026-08-15.2',
        connections: [MAIL_CONNECTION],
        // The recipient must resolve by DOMAIN: since the first-contact
        // exempt set was emptied (10/09), a boss chain no longer skips the
        // escalation, and an unresolved address would queue an approval — so
        // "the rest of the pass still runs" would fail for a reason that has
        // nothing to do with the broken inbox this test is about.
        knownCounterpartyEmailDomain: 'example.com',
        autonomyBase: { 'email.initiate': 'auto' },
      }),
      { businessId: BUSINESS },
    );
    const jobId = await jobReadyToRun(bundle.charterVersion);

    // A path with a plain file as one of its components: `mkdir(...,
    // { recursive: true })` fails with ENOTDIR here — a genuine filesystem
    // fault, not the one reserved-name `EEXIST` case `scanInbox`'s own
    // docblock names, and unguarded until this fix.
    const blockerDir = await mkdtemp(join(tmpdir(), 'sched-blocker-'));
    const blockerFile = join(blockerDir, 'not-a-directory');
    await writeFile(blockerFile, 'x', 'utf8');
    const brokenInbox = join(blockerFile, 'inbox');

    const sent: MailMessage[] = [];
    const pass = await schedulerPass({
      businessId: BUSINESS,
      runtime: runtimeWith(sent),
      inbox: brokenInbox,
      now: NOON,
    });

    expect(pass.scan).toBeNull();
    expect(pass.scanError).toBeTruthy();
    // `conduct`, `due` and `verified` all still ran despite the throw above:
    // the plan actually sent (due) and the job actually closed (verified) in
    // the same pass. Before this fix, an unguarded throw from `scanInbox`
    // would have rejected `schedulerPass` itself and none of this would
    // have happened at all.
    expect(sent).toHaveLength(1);
    expect(pass.due.ran.map((r) => r.jobId)).toContain(jobId);
    expect(pass.verified.closed).toContain(jobId);
    expect((await loadJob(jobId, { businessId: BUSINESS }))?.phase).toBe('closed');
  });
});
