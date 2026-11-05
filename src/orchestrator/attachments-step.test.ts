import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import type { CharterConnection, ConnectionBinding } from '../domain/connection.js';
import type { DocxSpec } from '../domain/document-spec.js';
import type { PolicyBundle } from '../domain/policy.js';
import { createProduction, saveVersion } from '../production/store.js';
import type { AttachmentRef } from '../domain/attachment-ref.js';
import { createJob, loadJob, transition } from './jobs.js';
import { AdapterRegistry } from './adapters/registry.js';
import { browserAdapter } from './adapters/browser.js';
import type { AdapterCall, ExternalAdapter } from './adapters/types.js';
import { envCredentials } from './credentials.js';
import { runPlan } from './run-plan.js';
import { renderStepEcho } from './command-echo.js';

/**
 * `performStep` resolves `attachments` from the EFFECTIVE payload (ruling
 * C16) and refuses before any adapter call. A spy adapter records every call,
 * so "refused before the adapter" is proven by an empty call list next to a
 * control that does reach it.
 */
const BUSINESS = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const PREFIX = 'TEST_CRED_';
const DIR = `produced/__attach-step-${process.pid}`;

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
  provider: null,
  lastOkAt: null,
  lastError: null,
};
const CREDENTIALS = envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX);

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'מכתב',
  filename: 'הצעה',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const paths = new Map<string, string>();
let lastVersionId: string | null = null;

async function produced(bytes: Buffer, versionNo = 1): Promise<AttachmentRef> {
  const productionId = await createProduction({
    businessId: BUSINESS,
    originJobId: 'J-origin',
    instructionText: 'תכיני מכתב',
    textOrigin: 'typed',
    format: 'docx',
    language: 'he',
    kind: 'letter',
    destination: { mode: 'save', folder: null },
    sourceDocumentIds: [],
  });
  const storedPath = `${DIR}/${productionId}-${versionNo}.docx`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  const producedVersionId = await saveVersion({
    productionId,
    versionNo,
    spec,
    storedPath,
    sha256: sha(bytes),
    sizeBytes: bytes.length,
  });
  paths.set(producedVersionId, join(config.documentRoot, storedPath));
  lastVersionId = producedVersionId;
  return { producedVersionId, sha256: sha(bytes), filename: 'הצעה.docx', sizeBytes: bytes.length };
}

function spy(): { calls: AdapterCall[]; registry: AdapterRegistry } {
  const calls: AdapterCall[] = [];
  const adapter: ExternalAdapter = {
    system: 'office-mail',
    channel: 'api',
    serves: ['mail.send'],
    async execute(call) {
      calls.push(call);
      return { ok: true, output: null, externalId: 'MSG-1' };
    },
  };
  return { calls, registry: new AdapterRegistry([adapter], [browserAdapter]) };
}

function mailPlan(attachments: unknown, extra: Record<string, unknown> = {}): Plan {
  return Plan.parse({
    goal: 'לשלוח מסמך',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'reply',
        toolName: 'mail.send',
        input: { to: 'a@b.com', inReplyTo: 'm1', subject: 'המסמך', body: 'מצורף', attachments, ...extra },
      },
    ],
  });
}

async function jobInExecute(bundle: PolicyBundle) {
  const job = await createJob({ charterVersion: bundle.charterVersion, provenance: 'boss', businessId: BUSINESS });
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: BUSINESS });
  }
  const loaded = await loadJob(job.jobId, { businessId: BUSINESS });
  if (loaded === null) throw new Error('job vanished');
  return loaded;
}

interface RunOptions {
  redactBeforeSending?: string[];
  /** Which business's document card names this job as its delivery job; null for none. Default: this business. */
  cardBusiness?: string | null;
}

async function run(plan: Plan, registry: AdapterRegistry, opts: RunOptions = {}) {
  const { redactBeforeSending } = opts;
  const cardBusiness = opts.cardBusiness === undefined ? BUSINESS : opts.cardBusiness;
  const bundle = await installCharter(
    buildCharter({
      connections: [MAIL_CONNECTION],
      knownCounterpartyEmailDomain: 'b.com',
      ...(redactBeforeSending !== undefined ? { redactBeforeSending } : {}),
    }),
    { businessId: BUSINESS },
  );
  const job = await jobInExecute(bundle);
  if (cardBusiness !== null && lastVersionId !== null) {
    await getPool().query(
      `INSERT INTO document_cards (card_id, business_id, version_id, state, delivery_job_id)
       VALUES ($1, $2, $3, 'approved', $4)`,
      [`DC-${job.jobId}`, cardBusiness, lastVersionId, job.jobId],
    );
  }
  return runPlan({
    job,
    bundle,
    plan,
    registry,
    bindings: [LIVE],
    credentials: CREDENTIALS,
    counterpartyTags: [],
    rampLevel: 'auto',
    now: NOON,
  });
}

beforeEach(async () => {
  await resetDatabase();
  lastVersionId = null;
});
afterEach(async () => {
  await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

describe('performStep and attachments', () => {
  it('hands the adapter the resolved bytes; a step without attachments gets []', async () => {
    const bytes = Buffer.from('approved docx bytes');
    const ref = await produced(bytes);
    const { calls, registry } = spy();
    const result = await run(mailPlan([ref]), registry);
    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.attachments).toEqual([
      {
        filename: 'הצעה.docx',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes,
      },
    ]);
  });

  it('the echo names exactly the file that is sent', async () => {
    const ref = await produced(Buffer.from('approved docx bytes'));
    const plan = mailPlan([ref]);
    const { calls, registry } = spy();
    expect((await run(plan, registry)).status).toBe('done');
    const sentName = calls[0]?.attachments[0]?.filename;
    expect(sentName).toBe('הצעה.docx');
    const line = renderStepEcho(plan.steps[0]!, 'ILS')
      .split('\n')
      .find((l) => l.startsWith('קובץ מצורף: '));
    expect(line?.split(' · ')[0]).toBe(`קובץ מצורף: ${sentName}`);
  });

  it('a job that is not a document delivery job cannot carry attachments', async () => {
    const ref = await produced(Buffer.from('approved docx bytes'));
    const { calls, registry } = spy();
    const result = await run(mailPlan([ref]), registry, { cardBusiness: null });
    expect(result).toMatchObject({ status: 'halted', reason: 'attachments_not_supported' });
    expect(calls).toHaveLength(0);
  });

  it("a delivery card of another business does not make this job a delivery job", async () => {
    const ref = await produced(Buffer.from('approved docx bytes'));
    const { calls, registry } = spy();
    const result = await run(mailPlan([ref]), registry, { cardBusiness: 'other-business' });
    expect(result).toMatchObject({ status: 'halted', reason: 'attachments_not_supported' });
    expect(calls).toHaveLength(0);
  });

  it('an empty attachments list needs no delivery job', async () => {
    const { calls, registry } = spy();
    expect((await run(mailPlan([]), registry, { cardBusiness: null })).status).toBe('done');
    expect(calls[0]?.attachments).toEqual([]);
  });

  it('a step with no attachments key reaches the adapter with attachments: []', async () => {
    const { calls, registry } = spy();
    const plan = Plan.parse({
      goal: 'g',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'reply',
          toolName: 'mail.send',
          input: { to: 'a@b.com', inReplyTo: 'm1', subject: 's', body: 'b' },
        },
      ],
    });
    expect((await run(plan, registry)).status).toBe('done');
    expect(calls[0]?.attachments).toEqual([]);
  });

  it('performStep fails before adapter.execute on mismatch (adapter spy not called)', async () => {
    const ref = await produced(Buffer.from('approved docx bytes'));
    await writeFile(paths.get(ref.producedVersionId)!, Buffer.from('swapped docx bytes!'));
    const { calls, registry } = spy();
    const result = await run(mailPlan([ref]), registry);
    expect(result).toMatchObject({ status: 'halted', reason: 'attachment_hash_mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('an unparseable attachments field is refused before the adapter', async () => {
    const { calls, registry } = spy();
    const result = await run(mailPlan([{ producedVersionId: 'x' }]), registry);
    expect(result).toMatchObject({ status: 'halted', reason: 'attachment_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('attachments on any tool other than mail.send → attachments_not_supported', async () => {
    const ref = await produced(Buffer.from('bytes'));
    const { calls, registry } = spy();
    const plan = Plan.parse({
      goal: 'g',
      steps: [
        {
          id: 's1',
          agent: 'comms.email',
          intent: 'recall',
          toolName: 'memory.recall',
          input: { query: 'x', attachments: [ref] },
        },
      ],
    });
    const result = await run(plan, registry);
    expect(result).toMatchObject({ status: 'halted', reason: 'attachments_not_supported' });
    expect(calls).toHaveLength(0);
  });

  it('redaction pattern matching the sha does not break the send', async () => {
    // A charter whose redaction patterns match the sha, the version id and the
    // filename: the REDACTED payload the adapter gets holds masks for all
    // three, and only the effective payload can still resolve the file.
    const bytes = Buffer.from('approved docx bytes');
    const ref = await produced(bytes);
    const { calls, registry } = spy();
    const result = await run(mailPlan([ref]), registry, {
      redactBeforeSending: ['[0-9a-f]{64}', 'DV-[0-9A-Z]+-[0-9]+', 'הצעה'],
    });
    expect(result.status).toBe('done');
    expect(calls).toHaveLength(1);
    // The patterns really fired on the payload the adapter got...
    const redacted = JSON.stringify(calls[0]?.input);
    expect(redacted).toContain('[הוסר]');
    expect(redacted).not.toContain(ref.sha256);
    expect(redacted).not.toContain(ref.producedVersionId);
    // ...and the attachment is still the approved bytes, under the approved name.
    expect(calls[0]?.attachments).toHaveLength(1);
    expect(calls[0]?.attachments[0]?.bytes.equals(bytes)).toBe(true);
    expect(calls[0]?.attachments[0]?.filename).toBe('הצעה.docx');
  });
});
