import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import type { CharterConnection } from '../domain/connection.js';
import type { DocxSpec } from '../domain/document-spec.js';
import { Plan } from '../domain/plan.js';
import { loadAutonomyMode } from '../governance/autonomy-mode.js';
import { saveDocumentSettings } from '../governance/document-settings.js';
import { loadConfirmation } from '../governance/instruction-confirmations.js';
import { loadInstructionForJob, saveInstruction } from '../governance/instructions.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { jobQualifiesForCuration } from '../memory/curation-trigger.js';
import { CONFIRMED_COMMAND_EXEMPTION_MARKER } from '../policy/confirmed-command.js';
import { AdapterRegistry } from '../orchestrator/adapters/registry.js';
import { createMailAdapter, type MailMessage } from '../orchestrator/adapters/mail.js';
import { upsertBinding } from '../orchestrator/bindings.js';
import { reaskFailedCommands } from '../orchestrator/command-reask.js';
import { envCredentials } from '../orchestrator/credentials.js';
import { createJob, loadJob, transition, type Job } from '../orchestrator/jobs.js';
import { runLocalTool } from '../orchestrator/local-tools.js';
import { loadStoredPlan, recordStepCompletion } from '../orchestrator/plan-store.js';
import { runDueJobs } from '../orchestrator/run-due.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { tick } from '../orchestrator/scheduler.js';
import { StepChannelError } from '../orchestrator/step-error.js';
import { createFakeMessenger } from '../whatsapp/fake-messenger.js';
import {
  approveDocumentCard,
  createDocumentCard,
  loadCardForVersion,
  loadDocumentCard,
  MAY_HAVE_SENT_LINE,
  onProductionFinished,
  reraiseFailedDeliveries,
  requestFix,
  RETRY_PREFIX,
} from './card.js';
import { UNAUTHORISED_ADDRESS_NOTE } from './produce-input.js';
import { PRODUCTION_TOOLS_MISSING_REASON } from './render-error.js';
import { advanceStage, createProduction, loadProduction, saveVersion, type ProductionDestination } from './store.js';
import { withTransaction } from '../db/pool.js';

const B = 'test-business';
const NOON = new Date('2026-08-18T09:00:00.000Z');
const PREFIX = 'TEST_CRED_';
const DIR = `produced/__card-${process.pid}`;
const AVAILABLE = { available: true, sofficePath: '/opt/soffice', chromiumPath: '/opt/chromium' };

const MAIL_CONNECTION: CharterConnection = {
  system: 'office-mail',
  label: 'תיבת המשרד',
  channel: 'api',
  serves: ['mail.send'],
  target: null,
  subprocessor: null,
};

const spec: DocxSpec = {
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title: 'הצעת מחיר לאלפא',
  filename: 'הצעה',
  style: { theme: 'clean', accent: 'navy' },
  sources: [],
  blocks: [{ type: 'paragraph', text: 'שלום' }],
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

let charterSeq = 0;
async function charter() {
  charterSeq += 1;
  return installCharter(buildCharter({ version: `card-${charterSeq}`, connections: [MAIL_CONNECTION] }), {
    businessId: B,
  });
}

/** A job the owner opened at the instruction door, sitting in `execute`. */
async function ownerJob(
  text: string,
  options: { textOrigin?: InstructionTextOrigin; instruction?: boolean; provenance?: 'boss' | 'unknown_external' } = {},
): Promise<Job> {
  const active = await charter();
  const job = await createJob({ charterVersion: active.charterVersion, provenance: options.provenance ?? 'boss', businessId: B });
  if (options.instruction !== false) {
    await saveInstruction({ jobId: job.jobId, text, textOrigin: options.textOrigin ?? 'typed' }, { businessId: B });
  }
  for (const to of ['understand', 'plan', 'execute'] as const) {
    await transition(job.jobId, { to, actor: 'orchestrator', reason: 'setup', businessId: B });
  }
  return (await loadJob(job.jobId, { businessId: B }))!;
}

async function productionCount(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>('SELECT COUNT(*)::text AS n FROM document_productions');
  return Number(rows[0]?.n ?? 0);
}

function produce(input: Record<string, unknown>, job: Job, production: unknown = AVAILABLE) {
  return runLocalTool('doc.produce', input, {
    jobId: job.jobId,
    businessId: B,
    ...(production === null ? {} : { production: production as typeof AVAILABLE }),
  });
}

const PRODUCE_INPUT = {
  format: 'docx',
  kind: 'letter',
  request: 'מכתב הצעת מחיר',
  destination: { mode: 'save', folder: null },
};

interface Ready {
  productionId: string;
  versionId: string;
  bytes: Buffer;
}

async function readyProduction(
  options: {
    destination?: ProductionDestination;
    textOrigin?: InstructionTextOrigin;
    instructionText?: string;
    stage?: 'ready' | 'failed_checks';
  } = {},
): Promise<Ready> {
  await charter();
  const productionId = await createProduction({
    businessId: B,
    originJobId: 'J-origin',
    instructionText: options.instructionText ?? 'תכיני הצעת מחיר ותשלחי ל-stranger@nowhere.example',
    textOrigin: options.textOrigin ?? 'typed',
    format: 'docx',
    language: 'he',
    kind: 'letter',
    destination: options.destination ?? { mode: 'send', to: ['stranger@nowhere.example'] },
    sourceDocumentIds: [],
  });
  const bytes = Buffer.from(`approved docx bytes ${productionId}`);
  const storedPath = `${DIR}/${productionId}.docx`;
  await mkdir(join(config.documentRoot, DIR), { recursive: true });
  await writeFile(join(config.documentRoot, storedPath), bytes);
  const versionId = await saveVersion({ productionId, versionNo: 1, spec, storedPath, sha256: sha(bytes), sizeBytes: bytes.length });
  expect(await advanceStage(productionId, 'queued', options.stage ?? 'ready', {})).toBe(true);
  return { productionId, versionId, bytes };
}

async function cardFor(versionId: string) {
  await createDocumentCard(versionId, { businessId: B });
  const card = await loadCardForVersion(B, versionId);
  if (card === null) throw new Error('no card');
  return card;
}

function runtimeWith(sent: MailMessage[]): Runtime {
  return {
    registry: new AdapterRegistry([
      createMailAdapter({
        system: 'office-mail',
        transport: {
          async send(message) {
            sent.push(message);
            return { messageId: `MSG-${sent.length}` };
          },
        },
      }),
    ]),
    credentials: envCredentials({ [`${PREFIX}OFFICE_MAIL`]: 'pw' }, PREFIX),
    warnings: [],
  };
}

async function liveMail(): Promise<void> {
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
    { businessId: B, by: 'test' },
  );
}

async function deliveryJobs(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM jobs WHERE business_id = $1 AND title LIKE 'מסירת מסמך%'`,
    [B],
  );
  return Number(rows[0]?.n ?? 0);
}

beforeEach(async () => {
  await resetDatabase();
});
afterEach(async () => {
  await rm(join(config.documentRoot, DIR), { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------- doc.produce

describe('doc.produce', () => {
  it("a non-boss job's doc.produce throws production_not_boss_instruction before creating a production", async () => {
    for (const job of [
      await ownerJob('תכיני מכתב', { provenance: 'unknown_external' }),
      // `boss` but not born at the instruction door: no boss_instructions row.
      await ownerJob('תכיני מכתב', { instruction: false }),
    ]) {
      const err = await produce(PRODUCE_INPUT, job).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StepChannelError);
      expect((err as StepChannelError).code).toBe('production_not_boss_instruction');
      // Refused before the payload was even parsed: a malformed payload gets
      // the same answer (the writer check ran first).
      const bad = await produce({ nonsense: true }, job).then(
        () => null,
        (e: unknown) => e,
      );
      expect((bad as StepChannelError).code).toBe('production_not_boss_instruction');
    }
    expect(await productionCount()).toBe(0);
    // Control: the owner's own instruction job does queue one.
    await produce(PRODUCE_INPUT, await ownerJob('תכיני מכתב'));
    expect(await productionCount()).toBe(1);
  });

  it('doc.produce parks the job in followup with wake_at NULL; wakeDueJobs does not wake it', async () => {
    const job = await ownerJob('תכיני מכתב');
    const result = await produce(PRODUCE_INPUT, job);
    expect(result).toMatchObject({ performed: true, parked: true });
    const parked = await loadJob(job.jobId, { businessId: B });
    expect(parked?.phase).toBe('followup');
    expect(parked?.wakeAt).toBeNull();
    const woke = await tick({ businessId: B, now: new Date('2099-01-01T00:00:00Z') });
    expect(woke.skipped).toBe(false);
    expect(woke.wokenJobs).not.toContain(job.jobId);
    expect((await loadJob(job.jobId, { businessId: B }))?.phase).toBe('followup');
    const production = await loadProduction(B, String(result['productionId']));
    expect(production?.originJobId).toBe(job.jobId);
    expect(production?.stage).toBe('queued');
  });

  it('refuses up front, with no row, when this server cannot produce documents', async () => {
    const job = await ownerJob('תכיני מכתב');
    for (const tools of [null, { ...AVAILABLE, available: false }, { ...AVAILABLE, chromiumPath: null }]) {
      const err = await produce(PRODUCE_INPUT, job, tools).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as StepChannelError).code).toBe('production_tools_missing');
      expect((err as StepChannelError).message).toBe(PRODUCTION_TOOLS_MISSING_REASON);
    }
    expect(await productionCount()).toBe(0);
    expect((await loadJob(job.jobId, { businessId: B }))?.phase).toBe('execute');
  });

  it('language is he unless the instruction asks for English', async () => {
    const cases: [string, string | undefined, string][] = [
      ['תכיני מכתב לספק', 'en', 'he'],
      ['תכיני מכתב לספק באנגלית', 'en', 'en'],
      ['Write the letter in English please', 'en', 'en'],
      ['תכיני מכתב לספק באנגלית', undefined, 'he'],
      ['תכיני מכתב לספק באנגלית', 'he', 'he'],
    ];
    for (const [text, language, expected] of cases) {
      const job = await ownerJob(text);
      const result = await produce({ ...PRODUCE_INPUT, ...(language !== undefined ? { language } : {}) }, job);
      expect((await loadProduction(B, String(result['productionId'])))?.language, `${text} / ${language}`).toBe(expected);
    }
  });

  it('an address not typed and not known to the charter is dropped and noted', async () => {
    const job = await ownerJob('תכיני הצעה ותשלחי לדנה וגם ל-typed@acme.example');
    const result = await produce(
      {
        ...PRODUCE_INPUT,
        destination: { mode: 'send', to: ['dana@stranger.example', 'typed@acme.example'] },
      },
      job,
    );
    const production = await loadProduction(B, String(result['productionId']));
    expect(production?.destination).toEqual({ mode: 'send', to: ['typed@acme.example'] });
    expect(production?.work.notes).toEqual([`${UNAUTHORISED_ADDRESS_NOTE}: dana@stranger.example`]);
  });

  it('a recording does not authorise an address it only spoke', async () => {
    const job = await ownerJob('תשלחי ל-typed@acme.example', { textOrigin: 'transcribed' });
    const result = await produce({ ...PRODUCE_INPUT, destination: { mode: 'send', to: ['typed@acme.example'] } }, job);
    const production = await loadProduction(B, String(result['productionId']));
    expect(production?.destination).toEqual({ mode: 'send', to: [] });
    expect(production?.work.notes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- approval

describe('approveDocumentCard', () => {
  it('approve creates a boss delivery job with a confirmed confirmation whose hash equals the shown plan; runDueJobs sends via confirmedCommandCovers under off', async () => {
    const { versionId, bytes } = await readyProduction();
    const card = await cardFor(versionId);
    expect(card.deliveryPlans.map((o) => o.option)).toEqual(['send', 'save']);
    const shown = card.deliveryPlans[0]!;

    const outcome = await approveDocumentCard(card.cardId, shown.planHash, 'dashboard', { businessId: B });
    if (outcome.status !== 'approved') throw new Error(`expected approval, got ${outcome.status}`);
    expect(outcome.option).toBe('send');

    const job = await loadJob(outcome.jobId, { businessId: B });
    expect(job?.provenance).toBe('boss');
    expect(job?.phase).toBe('execute');
    expect((await loadInstructionForJob(outcome.jobId, { businessId: B }))?.text).toContain('stranger@nowhere.example');
    const confirmation = await loadConfirmation(outcome.jobId, { businessId: B });
    expect(confirmation?.state).toBe('confirmed');
    expect(confirmation?.chosenPlanHash).toBe(shown.planHash);
    expect((await loadStoredPlan(outcome.jobId, { businessId: B }))?.planHash).toBe(shown.planHash);
    const after = await loadDocumentCard(B, card.cardId);
    expect(after).toMatchObject({ state: 'approved', deliveryJobId: outcome.jobId });

    await liveMail();
    expect(await loadAutonomyMode({ businessId: B })).toBe('off');
    const sent: MailMessage[] = [];
    const ran = await runDueJobs({ businessId: B, runtime: runtimeWith(sent), now: NOON });
    expect(ran.ran).toEqual([{ jobId: outcome.jobId, status: 'done', detail: null }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['stranger@nowhere.example']);
    expect(sent[0]?.attachments?.[0]?.filename).toBe('הצעה.docx');
    expect(sent[0]?.attachments?.[0]?.bytes.equals(bytes)).toBe(true);
    // It ran on the owner's confirmation, not on any autonomy.
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE job_id = $1 AND kind = 'intent_to_act'`,
      [outcome.jobId],
    );
    expect(rows.some((r) => r.reason.endsWith(CONFIRMED_COMMAND_EXEMPTION_MARKER))).toBe(true);
  });

  it('the subject and body are never model-written: fixed default, or the destination the owner gave', async () => {
    const { versionId } = await readyProduction();
    const send = (await cardFor(versionId)).deliveryPlans[0]!;
    expect(send.plan.steps[0]?.input).toMatchObject({
      to: ['stranger@nowhere.example'],
      subject: 'מצורף מכתב: הצעת מחיר לאלפא',
      body: 'מצורף מכתב: הצעת מחיר לאלפא.',
    });
  });

  it('approve with a stale planHash → card_stale, no job', async () => {
    const { versionId } = await readyProduction();
    const card = await cardFor(versionId);
    const stale = Plan.parse({
      goal: 'g',
      steps: [{ id: 'x', agent: 'comms.email', intent: 'i', toolName: 'mail.send', input: { to: ['evil@x.example'] } }],
    });
    expect(await approveDocumentCard(card.cardId, 'not-a-hash', 'dashboard', { businessId: B })).toEqual({
      status: 'card_stale',
    });
    // A plan smuggled into the stored card but not what the server builds is stale too.
    await getPool().query(
      `UPDATE document_cards SET delivery_plans = delivery_plans || $2::jsonb WHERE card_id = $1`,
      [card.cardId, JSON.stringify([{ option: 'send', label: 'x', planHash: 'smuggled', plan: stale }])],
    );
    expect((await approveDocumentCard(card.cardId, 'smuggled', 'dashboard', { businessId: B })).status).toBe('card_stale');
    expect(await deliveryJobs()).toBe(0);
    expect((await loadDocumentCard(B, card.cardId))?.state).toBe('open');
    // Control: the shown plan's hash does approve.
    const ok = await approveDocumentCard(card.cardId, card.deliveryPlans[1]!.planHash, 'dashboard', { businessId: B });
    expect(ok.status).toBe('approved');
    expect((await loadDocumentCard(B, card.cardId))?.state).toBe('saved');
  });

  it('approve after requestFix superseded the card → refused', async () => {
    const { versionId } = await readyProduction();
    const card = await cardFor(versionId);
    const fix = await requestFix(card.cardId, 'תקני את הכותרת', 'dashboard', 'typed', { businessId: B });
    expect(fix.status).toBe('opened');
    const outcome = await approveDocumentCard(card.cardId, card.deliveryPlans[0]!.planHash, 'dashboard', { businessId: B });
    expect(outcome).toEqual({ status: 'not_open', state: 'superseded' });
    expect(await deliveryJobs()).toBe(0);
  });

  it('double approve → one delivery job', async () => {
    const { versionId } = await readyProduction();
    const card = await cardFor(versionId);
    const hash = card.deliveryPlans[0]!.planHash;
    const results = await Promise.all([
      approveDocumentCard(card.cardId, hash, 'dashboard', { businessId: B }),
      approveDocumentCard(card.cardId, hash, 'whatsapp', { businessId: B }),
    ]);
    expect(results.filter((r) => r.status === 'approved')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'not_open')).toHaveLength(1);
    expect(await deliveryJobs()).toBe(1);
  });

  it('a card that did not pass the checks has nothing to approve', async () => {
    const { versionId } = await readyProduction({ stage: 'failed_checks' });
    const card = await cardFor(versionId);
    expect(card.deliveryPlans).toEqual([]);
  });
});

// ---------------------------------------------------------------- request a fix

describe('requestFix', () => {
  it('requestFix with a voice-origin original → text_origin transcribed', async () => {
    const { versionId } = await readyProduction({ textOrigin: 'transcribed' });
    const card = await cardFor(versionId);
    const fix = await requestFix(card.cardId, 'הוסיפי את המחיר', 'dashboard', 'typed', { businessId: B });
    if (fix.status !== 'opened') throw new Error(fix.status);
    const production = await loadProduction(B, fix.productionId);
    expect(production?.textOrigin).toBe('transcribed');
    expect(production?.instructionText).toBe('תכיני הצעת מחיר ותשלחי ל-stranger@nowhere.example\n\nתיקון: הוסיפי את המחיר');
    expect((await loadInstructionForJob(fix.jobId, { businessId: B }))?.textOrigin).toBe('transcribed');
    // Recipients re-checked on the joined, now-transcribed text: the address
    // only the recording carries is no longer authorised.
    expect(production?.destination).toEqual({ mode: 'send', to: [] });
    const job = await loadJob(fix.jobId, { businessId: B });
    expect(job).toMatchObject({ provenance: 'boss', phase: 'followup', wakeAt: null });
    // Control: typed + typed stays typed and keeps the typed address.
    const typed = await readyProduction();
    const fix2 = await requestFix((await cardFor(typed.versionId)).cardId, 'תקני', 'dashboard', 'typed', { businessId: B });
    if (fix2.status !== 'opened') throw new Error(fix2.status);
    const p2 = await loadProduction(B, fix2.productionId);
    expect(p2?.textOrigin).toBe('typed');
    expect(p2?.destination).toEqual({ mode: 'send', to: ['stranger@nowhere.example'] });
  });

  it('counts toward the daily cap and is refused past it', async () => {
    const { versionId } = await readyProduction();
    const card = await cardFor(versionId);
    const refused = await requestFix(card.cardId, 'תקני', 'dashboard', 'typed', { businessId: B, perDay: 0 });
    expect(refused.status).toBe('refused');
    expect((await loadDocumentCard(B, card.cardId))?.state).toBe('open');
  });
});

// ---------------------------------------------------------------- notifications

describe('createDocumentCard and its notices', () => {
  it('sends the file on the chosen channels once; a repeat call is a no-op', async () => {
    const { versionId, bytes } = await readyProduction();
    await saveDocumentSettings({ toWhatsApp: true, toEmail: true, toScreen: false, baseFolder: null }, { businessId: B });
    const emails: { subject: string; body: string; bytes: Buffer }[] = [];
    const messenger = createFakeMessenger();
    const seams = {
      businessId: B,
      messenger,
      sendAlertWithAttachment: async (subject: string, body: string, file: { bytes: Buffer }) => {
        emails.push({ subject, body, bytes: file.bytes });
        return { ok: true };
      },
    };
    const first = await createDocumentCard(versionId, seams);
    expect(first.status).toBe('created');
    expect(emails).toHaveLength(1);
    expect(emails[0]?.bytes.equals(bytes)).toBe(true);
    expect(emails[0]?.body).toContain('שלחי ל-stranger@nowhere.example');
    expect(messenger.sentFiles).toHaveLength(1);
    const card = await loadCardForVersion(B, versionId);
    expect(card).toMatchObject({ emailState: 'sent', whatsappState: 'sent' });
    expect(card?.whatsappDeliveredAt).not.toBeNull();

    const again = await createDocumentCard(versionId, seams);
    expect(again.status).toBe('exists');
    expect(emails).toHaveLength(1);
    expect(messenger.sentFiles).toHaveLength(1);
  });

  it('a chosen channel with no seam is skipped_not_connected; an unchosen one stays NULL', async () => {
    const { versionId } = await readyProduction();
    await saveDocumentSettings({ toWhatsApp: true, toEmail: false, toScreen: true, baseFolder: null }, { businessId: B });
    await createDocumentCard(versionId, { businessId: B });
    expect(await loadCardForVersion(B, versionId)).toMatchObject({ whatsappState: 'skipped_not_connected', emailState: null });
  });

  it('a production that ended with no version notifies once', async () => {
    await charter();
    const productionId = await createProduction({
      businessId: B,
      originJobId: 'J-x',
      instructionText: 'תכיני',
      textOrigin: 'typed',
      format: 'docx',
      language: 'he',
      kind: 'letter',
      destination: { mode: 'save', folder: null },
      sourceDocumentIds: [],
    });
    const alerts: string[] = [];
    const seams = { businessId: B, sendAlert: async (_s: string, body: string) => (alerts.push(body), { ok: true }) };
    const finished = { productionId, versionId: null, stage: 'failed' as const, reason: 'ניסוח המסמך נכשל' };
    await onProductionFinished(finished, seams);
    await onProductionFinished(finished, seams);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('ניסוח המסמך נכשל');
  });
});

// ---------------------------------------------------------------- exclusions and the failed delivery

describe('exclusions', () => {
  it('curation excludes doc.produce plans', () => {
    const plan = (toolName: string) =>
      Plan.parse({ goal: 'g', steps: [{ id: 's', agent: 'prod.docs', intent: 'i', toolName, input: {} }] });
    expect(jobQualifiesForCuration(plan('doc.produce'))).toBe(false);
    // Control: a reading plan qualifies, so the exclusion is what said no.
    expect(jobQualifiesForCuration(plan('doc.fetch'))).toBe(true);
  });

  /** A delivery job that failed after its step was claimed — a re-ask candidate shape. */
  async function failedDelivery(unknown: boolean): Promise<{ cardId: string; jobId: string }> {
    const { versionId } = await readyProduction();
    const card = await cardFor(versionId);
    const outcome = await approveDocumentCard(card.cardId, card.deliveryPlans[0]!.planHash, 'dashboard', {
      businessId: B,
    });
    if (outcome.status !== 'approved') throw new Error(outcome.status);
    const stored = await loadStoredPlan(outcome.jobId, { businessId: B });
    await getPool().query(
      `INSERT INTO confirmed_step_claims (business_id, job_id, step_id, plan_hash) VALUES ($1, $2, 'deliver', $3)`,
      [B, outcome.jobId, stored!.planHash],
    );
    if (unknown) {
      await withTransaction((tx) =>
        recordStepCompletion(tx, {
          jobId: outcome.jobId,
          businessId: B,
          planHash: stored!.planHash,
          stepId: 'deliver',
          externalId: null,
          status: 'unknown',
          performed: null,
        } as Parameters<typeof recordStepCompletion>[1]),
      );
    }
    await transition(outcome.jobId, { to: 'failed', actor: 'orchestrator', reason: 'adapter_timeout', businessId: B });
    return { cardId: card.cardId, jobId: outcome.jobId };
  }

  it('reask skips a failed delivery job; the card returns once with "השליחה הקודמת לא הושלמה"', async () => {
    const { cardId, jobId } = await failedDelivery(false);
    expect((await reaskFailedCommands({ businessId: B })).reasked).toEqual([]);

    await saveDocumentSettings({ toWhatsApp: true, toEmail: false, toScreen: true, baseFolder: null }, { businessId: B });
    const messenger = createFakeMessenger();
    const first = await reraiseFailedDeliveries({ businessId: B, messenger });
    expect(first.reraised).toEqual([{ cardId, jobId, mayHaveSent: false }]);
    expect(messenger.sentFiles).toHaveLength(1);
    expect(messenger.sentFiles[0]?.caption.startsWith(RETRY_PREFIX)).toBe(true);
    expect(messenger.sentFiles[0]?.caption).not.toContain(MAY_HAVE_SENT_LINE);
    expect((await loadDocumentCard(B, cardId))?.state).toBe('failed_send');
    // Once.
    expect((await reraiseFailedDeliveries({ businessId: B, messenger })).reraised).toEqual([]);
    expect(messenger.sentFiles).toHaveLength(1);

    // Control: the very same job, no longer named by a card, IS a re-ask
    // candidate — the card marker is what kept it out.
    await getPool().query('UPDATE document_cards SET delivery_job_id = NULL WHERE card_id = $1', [cardId]);
    const control = await reaskFailedCommands({ businessId: B });
    expect(control.reasked.map((r) => r.oldJobId)).toEqual([jobId]);
  });

  it('after an unknown step row the returned card also says the mail may already have gone', async () => {
    const { cardId } = await failedDelivery(true);
    await saveDocumentSettings({ toWhatsApp: true, toEmail: false, toScreen: true, baseFolder: null }, { businessId: B });
    const messenger = createFakeMessenger();
    const result = await reraiseFailedDeliveries({ businessId: B, messenger });
    expect(result.reraised).toEqual([expect.objectContaining({ cardId, mayHaveSent: true })]);
    expect(messenger.sentFiles[0]?.caption).toContain(MAY_HAVE_SENT_LINE);
  });

  it('a returned card can be approved again: a new delivery job', async () => {
    const { cardId, jobId } = await failedDelivery(false);
    await reraiseFailedDeliveries({ businessId: B });
    const card = await loadDocumentCard(B, cardId);
    const again = await approveDocumentCard(cardId, card!.deliveryPlans[0]!.planHash, 'dashboard', { businessId: B });
    if (again.status !== 'approved') throw new Error(again.status);
    expect(again.jobId).not.toBe(jobId);
    expect((await loadDocumentCard(B, cardId))?.deliveryJobId).toBe(again.jobId);
  });
});
