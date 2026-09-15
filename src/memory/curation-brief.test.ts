import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { Plan } from '../domain/plan.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { buildCurationBrief, MAX_BRIEF_CHARS } from './curation-brief.js';

const BUSINESS = 'test-business';

async function seedJobWithPlan(toolName: string, input: Record<string, unknown>): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: 'curation' }), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'לשלוח לרונית עדכון',
  });
  const plan = Plan.parse({
    goal: 'לשלוח לרונית עדכון',
    steps: [
      {
        id: 's1',
        agent: 'comms.email',
        intent: 'לשלוח עדכון',
        toolName,
        input,
      },
    ],
  });
  await bindPlanToJob(job.jobId, plan, { businessId: BUSINESS });
  return job.jobId;
}

describe('the brief the curator is asked about', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null for a job with no bound plan', async () => {
    const bundle = await installCharter(buildCharter({ version: 'curation' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: 'ללא תוכנית',
    });
    expect(await buildCurationBrief(job.jobId, { businessId: BUSINESS })).toBeNull();
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
});
