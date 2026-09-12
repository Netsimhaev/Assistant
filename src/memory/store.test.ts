import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import type { TrustLevel } from '../domain/trust.js';
import {
  MAX_RECALL,
  MemoryJobUnresolvedError,
  recallMemories,
  retireMemories,
  writeMemory,
} from './store.js';

const BUSINESS = 'test-business';

async function aJob(provenance: TrustLevel, title = 'memory'): Promise<string> {
  const bundle = await installCharter(buildCharter({ version: `mem-${title}-${provenance}` }), {
    businessId: BUSINESS,
  });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance,
    businessId: BUSINESS,
    title,
  });
  return job.jobId;
}

describe('the memory store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('writes and recalls an entity', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'c_812', body: { name: 'אלפא ציוד טכני' } },
      { businessId: BUSINESS },
    );

    const found = await recallMemories({ subjectKey: 'c_812' }, { businessId: BUSINESS });
    expect(found).toHaveLength(1);
    expect(found[0]?.body).toEqual({ name: 'אלפא ציוד טכני' });
    expect(found[0]?.kind).toBe('entity');
  });

  /**
   * The control this module exists for.
   *
   * A supplier's document saying "our new account is X" is a claim that
   * supplier made. Writing it down must not convert it into something the
   * business knows — so the trust level of the job that wrote it is stored and
   * comes back with it. Without this a prompt injection simply takes a day
   * longer to land.
   */
  it('stamps the provenance of the writing job, and returns it on recall', async () => {
    const bossJob = await aJob('boss', 'owner-said');
    const documentJob = await aJob('unknown_external', 'supplier-said');

    await writeMemory(
      { jobId: bossJob, kind: 'chunk', subjectKey: 'c_900', body: { text: 'הבעלים אמר' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      { jobId: documentJob, kind: 'chunk', subjectKey: 'c_900', body: { text: 'הספק אמר' } },
      { businessId: BUSINESS },
    );

    const found = await recallMemories({ subjectKey: 'c_900' }, { businessId: BUSINESS });
    expect(found).toHaveLength(2);
    const byText = new Map(found.map((m) => [String(m.body['text']), m.provenance]));
    expect(byText.get('הבעלים אמר')).toBe('boss');
    expect(byText.get('הספק אמר')).toBe('unknown_external');
  });

  /**
   * And the caller cannot choose it. `WriteMemoryInput` has no `provenance`
   * field at all — this asserts the behaviour rather than the type, because a
   * type is not a control: an object with an extra key satisfies it at
   * runtime, and this is the one place where being wrong laundries a
   * stranger's claim into the owner's knowledge.
   */
  it('ignores a provenance the caller tries to supply', async () => {
    const jobId = await aJob('unknown_external', 'tries-to-lie');
    const sneaky = {
      jobId,
      kind: 'entity' as const,
      subjectKey: 'c_evil',
      body: { claim: 'החשבון החדש' },
      provenance: 'boss',
    };

    await writeMemory(sneaky, { businessId: BUSINESS });

    const found = await recallMemories({ subjectKey: 'c_evil' }, { businessId: BUSINESS });
    expect(found[0]?.provenance).toBe('unknown_external');
  });

  it('refuses a write whose job does not resolve, rather than defaulting', async () => {
    await expect(
      writeMemory(
        { jobId: 'J-does-not-exist', kind: 'chunk', subjectKey: 'x', body: {} },
        { businessId: BUSINESS },
      ),
    ).rejects.toBeInstanceOf(MemoryJobUnresolvedError);
  });

  it('does not read another business’s memories', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'c_812', body: { name: 'שלנו' } },
      { businessId: BUSINESS },
    );

    const other = await recallMemories({ subjectKey: 'c_812' }, { businessId: 'someone-else' });
    expect(other).toEqual([]);
  });

  it('replaces an entity and retires what it replaced, rather than deleting it', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'c_812', body: { phone: '03-1111111' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'c_812', body: { phone: '03-2222222' } },
      { businessId: BUSINESS },
    );

    const live = await recallMemories({ subjectKey: 'c_812' }, { businessId: BUSINESS });
    expect(live).toHaveLength(1);
    expect(live[0]?.body).toEqual({ phone: '03-2222222' });

    // The old belief is still on the record — that is what "retire, never
    // delete" buys, and a business asked to explain last quarter's decision
    // needs it.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM memories
        WHERE business_id=$1 AND subject_key='c_812' AND retired_at IS NOT NULL`,
      [BUSINESS],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('keeps one live value per preference attribute, and separate ones apart', async () => {
    const jobId = await aJob('boss');
    const pref = (attribute: string, value: string) =>
      writeMemory(
        { jobId, kind: 'preference', subjectKey: 'c_812', attribute, body: { value } },
        { businessId: BUSINESS },
      );

    await pref('meeting_time', 'בוקר');
    await pref('language', 'עברית');
    await pref('meeting_time', 'אחר הצהריים');

    const found = await recallMemories(
      { subjectKey: 'c_812', kind: 'preference' },
      { businessId: BUSINESS },
    );
    expect(found).toHaveLength(2);
    const byAttribute = new Map(found.map((m) => [m.attribute, String(m.body['value'])]));
    expect(byAttribute.get('meeting_time')).toBe('אחר הצהריים');
    expect(byAttribute.get('language')).toBe('עברית');
  });

  it('accumulates chunks instead of replacing them', async () => {
    const jobId = await aJob('boss');
    for (const text of ['ראשון', 'שני', 'שלישי']) {
      await writeMemory(
        { jobId, kind: 'chunk', subjectKey: 'c_812', body: { text } },
        { businessId: BUSINESS },
      );
    }
    const found = await recallMemories({ subjectKey: 'c_812' }, { businessId: BUSINESS });
    expect(found).toHaveLength(3);
  });

  it('retires by subject and stops returning what it retired', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'entity', subjectKey: 'c_gone', body: { name: 'ספק שסגר' } },
      { businessId: BUSINESS },
    );

    expect(
      await retireMemories(
        { kind: 'entity', subjectKey: 'c_gone', reason: 'הספק סגר' },
        { businessId: BUSINESS },
      ),
    ).toBe(1);

    expect(await recallMemories({ subjectKey: 'c_gone' }, { businessId: BUSINESS })).toEqual([]);

    // Retiring again touches nothing, and says so rather than reporting success.
    expect(
      await retireMemories(
        { kind: 'entity', subjectKey: 'c_gone', reason: 'שוב' },
        { businessId: BUSINESS },
      ),
    ).toBe(0);
  });

  it('finds a memory by a word in its text', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'c_812', body: { text: 'מעדיפים משלוח בבוקר' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'c_999', body: { text: 'תנאי תשלום שוטף plus 60' } },
      { businessId: BUSINESS },
    );

    const found = await recallMemories({ keyword: 'משלוח' }, { businessId: BUSINESS });
    expect(found).toHaveLength(1);
    expect(found[0]?.subjectKey).toBe('c_812');
  });

  /**
   * A keyword is model-authored text and may contain anything. `%` is the
   * wildcard that matches the entire store, so a recall for a literal percent
   * sign must not quietly become "give me everything".
   */
  it('treats a wildcard character in a keyword as a literal', async () => {
    const jobId = await aJob('boss');
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'c_1', body: { text: 'הנחה של 5% על ההזמנה' } },
      { businessId: BUSINESS },
    );
    await writeMemory(
      { jobId, kind: 'chunk', subjectKey: 'c_2', body: { text: 'אין הנחה' } },
      { businessId: BUSINESS },
    );

    expect(await recallMemories({ keyword: '5%' }, { businessId: BUSINESS })).toHaveLength(1);

    // A bare `%` is the wildcard that would match every row in the store. It
    // must match only the row that literally contains a percent sign — which
    // is one of the two written above, so this assertion distinguishes
    // "escaped correctly" from both "matched everything" (2) and "matched
    // nothing" (0). The first draft of this test expected 0 and was simply
    // wrong about its own fixture.
    const percent = await recallMemories({ keyword: '%' }, { businessId: BUSINESS });
    expect(percent).toHaveLength(1);
    expect(String(percent[0]?.body['text'])).toContain('5%');
  });

  it('caps how much one recall may return, whatever it was asked for', async () => {
    const jobId = await aJob('boss');
    for (let i = 0; i < MAX_RECALL + 5; i += 1) {
      await writeMemory(
        { jobId, kind: 'chunk', subjectKey: 'c_many', body: { text: `פריט ${i}` } },
        { businessId: BUSINESS },
      );
    }
    const found = await recallMemories(
      { subjectKey: 'c_many', limit: 1_000 },
      { businessId: BUSINESS },
    );
    expect(found).toHaveLength(MAX_RECALL);
  });
});
