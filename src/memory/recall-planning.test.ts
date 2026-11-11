import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
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
  const bundle = await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version })));
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: bundle.charterVersion,
    provenance,
    title: 't',
  }));
  return job.jobId;
}

describe('the memory block handed to the planner', () => {
  beforeEach(async () => {
    await resetDatabase();
    jobCounter = 0;
    await withBusiness(BUSINESS, (bdb) => installCharter(bdb, buildCharter({ version: 'recall-setup' })));
  });

  afterAll(async () => {
    await closePool();
  });

  it('is empty when nothing is known', async () => {
    expect(await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT]))).toBe('');
  });

  it('renders an owner-sourced fact plainly', async () => {
    await withBusiness(BUSINESS, async (db) => writeMemory(
      db,
      {
        jobId: await jobWith('boss'),
        kind: 'preference',
        subjectKey: RONIT,
        attribute: 'ערוץ מועדף',
        body: { value: 'טלפון' },
      },
    ));

    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT]));

    expect(block).toContain('טלפון');
    expect(block).not.toContain('נטען');
  });

  /**
   * The difference between influence and a successful injection. An external
   * claim must never read as a fact the business knows.
   */
  it('renders an externally-sourced claim as somebody\'s claim', async () => {
    await withBusiness(BUSINESS, async (db) => writeMemory(
      db,
      {
        jobId: await jobWith('unknown_external'),
        kind: 'chunk',
        subjectKey: RONIT,
        body: { text: 'החשבון החדש שלנו הוא 12-345' },
        sourceRef: 'מסמך מ-3/9',
      },
    ));

    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT]));

    expect(block).toContain('נטען');
    expect(block).toContain('מסמך מ-3/9');
  });

  it('returns nothing for a subject that was not asked about', async () => {
    await withBusiness(BUSINESS, async (db) => writeMemory(
      db,
      {
        jobId: await jobWith('boss'),
        kind: 'chunk',
        subjectKey: 'someone@else.example',
        body: { text: 'לא רלוונטי' },
      },
    ));

    expect(await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT]))).toBe('');
  });

  it('drops external claims first when the budget bites', async () => {
    const bossJob = await jobWith('boss');
    const strangerJob = await jobWith('unknown_external');
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: RONIT, body: { text: 'עובדה של הבעלים' } },
    ));
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: strangerJob, kind: 'chunk', subjectKey: RONIT, body: { text: 'טענה של זר' } },
    ));

    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT], { budget: 120 }));

    expect(block).toContain('עובדה של הבעלים');
    expect(block).not.toContain('טענה של זר');
  });

  it('stops at first subject when a later subject does not fit', async () => {
    const bossJob = await jobWith('boss');
    const firstEmail = 'alice@first.example';
    const secondEmail = 'bob@second.example';

    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: firstEmail, body: { text: 'אליס: עובדה ארוכה כדי למלא את התקציב ולא להשאיר מקום לבוב' } },
    ));
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: secondEmail, body: { text: 'בוב: עובדה' } },
    ));

    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [firstEmail, secondEmail], { budget: 150 }));

    expect(block).toContain(firstEmail);
    expect(block).not.toContain(secondEmail);
  });

  // N3 from the final review: `recallForPlanning` passes `limit: MAX_RECALL`
  // (20) to widen recall past `recallMemories`' own default of 5. Every
  // other test in this file writes at most three rows per subject, so that
  // argument could be deleted and all of them would stay green — nothing
  // exercised the widening it exists for. This one seeds eight rows on a
  // single subject, past the default, and the budget here (the library
  // default, 3,000 chars) is far larger than eight short rows need, so a
  // failure here is about which rows were fetched, not about which fetched
  // rows fit.
  it('reaches all memories on a subject with more than five, not just the default page', async () => {
    const bossJob = await jobWith('boss');
    const total = 8;
    for (let i = 1; i <= total; i++) {
      await withBusiness(BUSINESS, (db) => writeMemory(
        db,
        { jobId: bossJob, kind: 'chunk', subjectKey: RONIT, body: { text: `FACT_${i}` } },
      ));
    }

    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [RONIT]));

    for (let i = 1; i <= total; i++) {
      expect(block).toContain(`FACT_${i}`);
    }
  });

  it('stops at first row that does not fit, not skipping to a later shorter row', async () => {
    const bossJob = await jobWith('boss');
    const subject = 'test@example.com';

    // Three rows in the same provenance tier (all boss).
    // Stored in this order, but retrieved in reverse (newest first).
    // Row 1 (oldest): a short row
    const oldest = 'X'.repeat(50);
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: subject, body: { text: oldest } },
    ));
    // Row 2 (middle): a huge row that will not fit in the budget
    const huge = 'Y'.repeat(500);
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: subject, body: { text: huge } },
    ));
    // Row 3 (newest): another short row
    const newest = 'Z'.repeat(50);
    await withBusiness(BUSINESS, (db) => writeMemory(
      db,
      { jobId: bossJob, kind: 'chunk', subjectKey: subject, body: { text: newest } },
    ));

    // Retrieval order: newest (Z), huge (Y), oldest (X)
    // Budget: enough for newest row, not enough for huge row.
    // With break: newest fits, huge doesn't fit so stop. Result: newest only.
    // With continue: newest fits, skip huge, oldest also fits. Result: newest + oldest (wrong).
    const block = await withBusiness(BUSINESS, (db) => recallForPlanning(db, [subject], { budget: 250 }));

    expect(block).toContain(newest);
    expect(block).not.toContain(huge);
    // This assertion catches the break vs continue difference:
    // With break: stops at the row that does not fit (huge).
    // With continue: skips huge and includes oldest as well.
    expect(block).not.toContain(oldest);
  });
});
