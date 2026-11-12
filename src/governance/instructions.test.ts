import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import {
  MAX_INSTRUCTION_CHARS,
  loadInstructionForJob,
  claimAnswer,
  saveInstruction,
} from './instructions.js';

const BUSINESS = 'test-business';

async function aBossJob(): Promise<string> {
  const charter = buildCharter();
  await withBusiness(BUSINESS, (bdb) => installCharter(bdb, charter));
  const job = await withBusiness(BUSINESS, (db) => createJob(db, {
    charterVersion: charter.charterVersion,
    provenance: 'boss',
    title: 'הוראה',
  }));
  return job.jobId;
}

describe('the instruction record', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('stores the text verbatim and reads it back by job', async () => {
    const jobId = await aBossJob();
    // Trailing spaces and an inner newline are kept: the recipient rule
    // matches against these exact bytes, so normalising here would silently
    // change what counts as "named in the instruction".
    const text = 'תשלחי לדנה  \ndana@example.com את ההצעה';

    const saved = await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text }));
    const read = await withBusiness(BUSINESS, (bdb) => loadInstructionForJob(bdb, jobId));

    expect(saved.text).toBe(text);
    expect(read?.text).toBe(text);
    expect(read?.answer).toBeNull();
    expect(read?.instructionId).toBe(saved.instructionId);
  });

  it('records an answer beside the instruction, not in place of it', async () => {
    const jobId = await aBossJob();
    const saved = await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: 'תשלחי לדנה את ההצעה' }));

    await withBusiness(BUSINESS, (bdb) => claimAnswer(bdb, saved.instructionId, 'דנה כהן, dana@example.com'));

    const read = await withBusiness(BUSINESS, (bdb) => loadInstructionForJob(bdb, jobId));
    expect(read?.text).toBe('תשלחי לדנה את ההצעה');
    expect(read?.answer).toBe('דנה כהן, dana@example.com');
  });

  it('refuses an empty instruction', async () => {
    const jobId = await aBossJob();
    // Asserts on the Hebrew message, not just any rejection: a bare
    // toThrow() would stay green even if the TypeScript check vanished and
    // only the database CHECK caught it, leaving the owner with a raw
    // Postgres error instead of a Hebrew sentence.
    await expect(
      withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: '   ' })),
    ).rejects.toThrow('ההוראה ריקה');
  });

  it('refuses an instruction past the cap', async () => {
    const jobId = await aBossJob();
    const tooLong = 'א'.repeat(MAX_INSTRUCTION_CHARS + 1);
    // Same reasoning as above, plus the intake-folder sentence: that phrasing
    // is what tells the owner where a whole document belongs instead of the
    // instruction box. A Postgres CHECK violation carries neither.
    await expect(
      withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: tooLong })),
    ).rejects.toThrow(/4000/);
    await expect(
      withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: tooLong })),
    ).rejects.toThrow(/תיקיית הקליטה/);
  });

  it('never returns another business\'s instruction', async () => {
    const jobId = await aBossJob();
    await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: 'תשלחי לדנה' }));
    expect(await withBusiness('someone-else', (bdb) => loadInstructionForJob(bdb, jobId))).toBeNull();
  });

  it('refuses a second instruction on the same job', async () => {
    const jobId = await aBossJob();
    await withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: 'ראשונה' }));
    await expect(
      withBusiness(BUSINESS, (bdb) => saveInstruction(bdb, { textOrigin: 'typed', jobId, text: 'שנייה' })),
    ).rejects.toThrow();
    const { rows } = await testDb().query(`SELECT 1 FROM boss_instructions`);
    expect(rows).toHaveLength(1);
  });
});
