import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { writeMemory } from './store.js';
import { recallForPlanning } from './recall-planning.js';

const BUSINESS = 'test-business';
const RONIT = 'ronit@beta-log.example';
let jobCounter = 0;

async function jobWith(provenance: 'boss' | 'unknown_external'): Promise<string> {
  // One argument, `charterVersion` required, no `counterpartyTags`.
  const version = `recall-job-${jobCounter++}`;
  const bundle = await installCharter(buildCharter({ version }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    title: 't',
    businessId: BUSINESS,
  });
  return job.jobId;
}

describe('the memory block handed to the planner', () => {
  beforeEach(async () => {
    await resetDatabase();
    jobCounter = 0;
    await installCharter(buildCharter({ version: 'recall-setup' }), { businessId: BUSINESS });
  });

  afterAll(async () => {
    await closePool();
  });

  it('is empty when nothing is known', async () => {
    expect(await recallForPlanning([RONIT], { businessId: BUSINESS })).toBe('');
  });

  it('renders an owner-sourced fact plainly', async () => {
    await writeMemory(
      {
        jobId: await jobWith('boss'),
        kind: 'preference',
        subjectKey: RONIT,
        attribute: 'ערוץ מועדף',
        body: { value: 'טלפון' },
      },
      { businessId: BUSINESS },
    );

    const block = await recallForPlanning([RONIT], { businessId: BUSINESS });

    expect(block).toContain('טלפון');
    expect(block).not.toContain('נטען');
  });

  /**
   * The difference between influence and a successful injection. An external
   * claim must never read as a fact the business knows.
   */
  it('renders an externally-sourced claim as somebody\'s claim', async () => {
    await writeMemory(
      {
        jobId: await jobWith('unknown_external'),
        kind: 'chunk',
        subjectKey: RONIT,
        body: { text: 'החשבון החדש שלנו הוא 12-345' },
        sourceRef: 'מסמך מ-3/9',
      },
      { businessId: BUSINESS },
    );

    const block = await recallForPlanning([RONIT], { businessId: BUSINESS });

    expect(block).toContain('נטען');
    expect(block).toContain('מסמך מ-3/9');
  });

  it('returns nothing for a subject that was not asked about', async () => {
    await writeMemory(
      {
        jobId: await jobWith('boss'),
        kind: 'chunk',
        subjectKey: 'someone@else.example',
        body: { text: 'לא רלוונטי' },
      },
      { businessId: BUSINESS },
    );

    expect(await recallForPlanning([RONIT], { businessId: BUSINESS })).toBe('');
  });

  it('drops external claims first when the budget bites', async () => {
    const bossJob = await jobWith('boss');
    const strangerJob = await jobWith('unknown_external');
    await writeMemory(
      { jobId: bossJob, kind: 'chunk', subjectKey: RONIT, body: { text: 'עובדה של הבעלים' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      { jobId: strangerJob, kind: 'chunk', subjectKey: RONIT, body: { text: 'טענה של זר' } },
      { businessId: BUSINESS },
    );

    const block = await recallForPlanning([RONIT], { businessId: BUSINESS, budget: 120 });

    expect(block).toContain('עובדה של הבעלים');
    expect(block).not.toContain('טענה של זר');
  });
});
