import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { createJob } from '../orchestrator/jobs.js';
import {
  MAX_INSTRUCTION_CHARS,
  loadInstructionForJob,
  recordAnswer,
  saveInstruction,
} from './instructions.js';

const BUSINESS = 'test-business';

async function aBossJob(): Promise<string> {
  const charter = buildCharter();
  await installCharter(charter, { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: charter.charterVersion,
    provenance: 'boss',
    businessId: BUSINESS,
    title: 'הוראה',
  });
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

    const saved = await saveInstruction({ jobId, text }, { businessId: BUSINESS });
    const read = await loadInstructionForJob(jobId, { businessId: BUSINESS });

    expect(saved.text).toBe(text);
    expect(read?.text).toBe(text);
    expect(read?.answer).toBeNull();
    expect(read?.instructionId).toBe(saved.instructionId);
  });

  it('records an answer beside the instruction, not in place of it', async () => {
    const jobId = await aBossJob();
    const saved = await saveInstruction(
      { jobId, text: 'תשלחי לדנה את ההצעה' },
      { businessId: BUSINESS },
    );

    await recordAnswer(saved.instructionId, 'דנה כהן, dana@example.com', {
      businessId: BUSINESS,
    });

    const read = await loadInstructionForJob(jobId, { businessId: BUSINESS });
    expect(read?.text).toBe('תשלחי לדנה את ההצעה');
    expect(read?.answer).toBe('דנה כהן, dana@example.com');
  });

  it('refuses an empty instruction', async () => {
    const jobId = await aBossJob();
    await expect(
      saveInstruction({ jobId, text: '   ' }, { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('refuses an instruction past the cap', async () => {
    const jobId = await aBossJob();
    const tooLong = 'א'.repeat(MAX_INSTRUCTION_CHARS + 1);
    await expect(
      saveInstruction({ jobId, text: tooLong }, { businessId: BUSINESS }),
    ).rejects.toThrow();
  });

  it('never returns another business\'s instruction', async () => {
    const jobId = await aBossJob();
    await saveInstruction({ jobId, text: 'תשלחי לדנה' }, { businessId: BUSINESS });
    expect(await loadInstructionForJob(jobId, { businessId: 'someone-else' })).toBeNull();
  });

  it('refuses a second instruction on the same job', async () => {
    const jobId = await aBossJob();
    await saveInstruction({ jobId, text: 'ראשונה' }, { businessId: BUSINESS });
    await expect(
      saveInstruction({ jobId, text: 'שנייה' }, { businessId: BUSINESS }),
    ).rejects.toThrow();
    const { rows } = await getPool().query(`SELECT 1 FROM boss_instructions`);
    expect(rows).toHaveLength(1);
  });
});
