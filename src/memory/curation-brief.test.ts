import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan, type PlanStep } from '../domain/plan.js';
import type { Reading } from '../domain/reading.js';
import type { Proposal } from '../domain/proposal.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { insertOrGetDocument } from '../documents/store.js';
import { saveReading } from '../documents/reading-store.js';
import { saveProposal } from '../orchestrator/proposal-store.js';
import { buildCurationBrief, MAX_BRIEF_CHARS } from './curation-brief.js';

const BUSINESS = 'test-business';
const SOURCE = { ordinal: 0, locator: null };

type StepSpec = Pick<PlanStep, 'id' | 'agent' | 'toolName' | 'input'> & { intent?: string };

async function seedJob(title: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: 'curation' }), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title,
  });
  return job.jobId;
}

async function bindSteps(jobId: string, goal: string, steps: StepSpec[]): Promise<void> {
  const plan = Plan.parse({
    goal,
    steps: steps.map((step) => ({ intent: 'לבצע', ...step })),
  });
  await bindPlanToJob(jobId, plan, { businessId: BUSINESS });
}

async function seedJobWithPlan(toolName: string, input: Record<string, unknown>): Promise<string> {
  const jobId = await seedJob('לשלוח לרונית עדכון');
  await bindSteps(jobId, 'לשלוח לרונית עדכון', [
    { id: 's1', agent: 'comms.email', toolName, input },
  ]);
  return jobId;
}

/** A document + reading + proposal, linked to `jobId` the way `documentForApproval` walks it. */
async function seedReadingForJob(jobId: string, content: Reading): Promise<void> {
  const documentId = `DOC-${ulid()}`;
  await insertOrGetDocument(
    {
      documentId,
      source: 'manual',
      originalName: 'x.txt',
      mediaType: 'text/plain',
      sha256: ulid().padEnd(64, '0'),
      byteSize: 10,
      storedPath: `${BUSINESS}/${documentId}/original.txt`,
    },
    { businessId: BUSINESS },
  );
  const { record } = await saveReading(
    {
      readingId: `RDG-${ulid()}`,
      documentId,
      status: 'read',
      reason: null,
      content,
      provenance: 'unknown_external',
      model: 'haiku',
      promptVersion: 'v1',
      briefHash: `${ulid()}`.padEnd(64, 'a'),
    },
    { businessId: BUSINESS },
  );
  const proposalContent: Proposal = {
    stance: 'no_action',
    headline: 'נקרא, אין מה לעשות',
    reasons: [{ text: 'תיוק בלבד', findingLabel: 'סיכום', sourceRef: SOURCE }],
    action: null,
    clarifyingQuestion: null,
  };
  await saveProposal(
    {
      proposalId: `PRP-${ulid()}`,
      readingId: record.readingId,
      jobId,
      status: 'proposed',
      reason: null,
      content: proposalContent,
      raw: '{}',
      model: 'sonnet',
      promptVersion: 'v1',
    },
    { businessId: BUSINESS },
  );
}

describe('the brief the curator is asked about', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null for a job with no bound plan', async () => {
    const jobId = await seedJob('ללא תוכנית');
    expect(await buildCurationBrief(jobId, { businessId: BUSINESS })).toBeNull();
  });

  it('carries the job title and the outgoing body into the text', async () => {
    const jobId = await seedJobWithPlan('mail.send', {
      to: 'ronit@beta-log.example',
      subject: 'עדכון',
      body: 'סיכמנו שנדבר בטלפון ולא במייל',
    });

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief).not.toBeNull();
    expect(brief?.text).toContain('לשלוח לרונית עדכון');
    expect(brief?.text).toContain('סיכמנו שנדבר בטלפון ולא במייל');
  });

  /**
   * The touched set is the anti-injection control's raw material (Task 3).
   * If a recipient the job wrote to is missing from it, a true fact about that
   * recipient gets rejected; if a stranger appears in it, an injected claim
   * about that stranger gets accepted.
   */
  it('collects the recipients the plan actually addressed', async () => {
    const jobId = await seedJobWithPlan('mail.send', {
      to: 'ronit@beta-log.example',
      subject: 'עדכון',
      body: 'טקסט',
    });

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief?.touched.recipients).toEqual(['ronit@beta-log.example']);
  });

  /**
   * C1 (fix round 1): a `crm.write` payload's `email` field is the record's
   * content -- a new lead's address -- not somewhere the job wrote to.
   * `readEmails` cannot tell the difference on its own; only the step's
   * addressee can. A stranger leaking in here means a later task accepts a
   * curated claim about somebody the job never actually contacted.
   */
  it('does not treat a crm.write payload email as a recipient', async () => {
    const jobId = await seedJob('לתעד ליד חדש ולעדכן את רונית');
    await bindSteps(jobId, 'לתעד ליד חדש ולעדכן את רונית', [
      {
        id: 's1',
        agent: 'comms.email',
        toolName: 'mail.send',
        input: { to: 'ronit@beta-log.example', subject: 'עדכון', body: 'טקסט' },
      },
      {
        id: 's2',
        agent: 'ops.systems',
        toolName: 'crm.write',
        input: { email: 'lead@stranger.example', name: 'ליד חדש' },
      },
    ]);

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief?.touched.recipients).toEqual(['ronit@beta-log.example']);
    expect(brief?.touched.recipients).not.toContain('lead@stranger.example');
  });

  it('truncates to the ceiling and says so', async () => {
    const jobId = await seedJobWithPlan('mail.send', {
      to: 'ronit@beta-log.example',
      subject: 'עדכון',
      body: 'א'.repeat(MAX_BRIEF_CHARS + 5_000),
    });

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief!.text.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS);
    expect(brief!.text).toContain('[קוצץ]');
  });

  /**
   * C2 (fix round 1): a job that qualified for curation *by reading a
   * document* must carry that reading's summary and findings into the
   * brief -- this is the main case the whole sub-project was built for.
   */
  it('carries the reading summary and findings into the text', async () => {
    const jobId = await seedJob('לטפל בהצעת המחיר שהתקבלה');
    await bindSteps(jobId, 'לטפל בהצעת המחיר שהתקבלה', [
      { id: 's1', agent: 'know.reader', toolName: 'memory.recall', input: {} },
    ]);
    await seedReadingForJob(jobId, {
      summary: 'הצעת מחיר מספק חדש על סך 4,000 ש"ח',
      findings: [{ label: 'סכום', value: '4000 ש"ח', sourceRef: SOURCE }],
      intents: [{ intent: 'no_action', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' }],
      unreadable: [],
    });

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief?.text).toContain('הצעת מחיר מספק חדש על סך 4,000 ש"ח');
    expect(brief?.text).toContain('סכום: 4000 ש"ח');
  });

  /**
   * C2: only an `entity`-kind subject carries an id by construction
   * (`EntityRef` is a closed discriminated union, `src/domain/reading.ts`).
   * `sender` and `unresolved` intents must not contribute to
   * `touched.entityIds` -- there is nothing there Task 3 could check anyway.
   */
  it('adds entity-kind intent subjects to touched.entityIds, and no others', async () => {
    const jobId = await seedJob('לרשום ישות חדשה');
    await bindSteps(jobId, 'לרשום ישות חדשה', [
      { id: 's1', agent: 'know.reader', toolName: 'memory.recall', input: {} },
    ]);
    await seedReadingForJob(jobId, {
      summary: 'ספק חדש הציג את עצמו',
      findings: [],
      intents: [
        { intent: 'record_entity', subject: { kind: 'entity', entityId: 'supplier-beta-log' }, sourceRef: SOURCE, note: '' },
        { intent: 'reply_to_sender', subject: { kind: 'sender' }, sourceRef: SOURCE, note: '' },
        { intent: 'flag_for_owner', subject: { kind: 'unresolved', describedAs: 'מישהו בחתימה' }, sourceRef: SOURCE, note: '' },
      ],
      unreadable: [],
    });

    const brief = await buildCurationBrief(jobId, { businessId: BUSINESS });

    expect(brief?.touched.entityIds).toEqual(['supplier-beta-log']);
  });
});
