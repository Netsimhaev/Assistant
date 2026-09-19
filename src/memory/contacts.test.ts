import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { retireMemories, writeMemory } from './store.js';
import { listContacts } from './contacts.js';

const BUSINESS = 'test-business';

async function bossJob(version: string): Promise<string> {
  const bundle = await installCharter(buildCharter({ version }), { businessId: BUSINESS });
  const job = await createJob({
    charterVersion: bundle.charterVersion,
    provenance: 'boss',
    title: 'seed',
    businessId: BUSINESS,
  });
  return job.jobId;
}

describe('the contacts the resolver may match against', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns a live entity with its name, company and address', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c1'),
        kind: 'entity',
        subjectKey: 'ronit-cohen-beta-log',
        body: { name: 'רונית כהן', company: 'בטא לוגיסטיקה', email: 'ronit@beta-log.example' },
      },
      { businessId: BUSINESS },
    );

    const contacts = await listContacts({ businessId: BUSINESS });

    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe('רונית כהן');
    expect(contacts[0]?.company).toBe('בטא לוגיסטיקה');
    // Both keys: the entity id it is stored under, and the address the curator
    // writes under. Spec §8 — the same person is split across the two today.
    expect(contacts[0]?.subjectKeys).toEqual(
      expect.arrayContaining(['ronit-cohen-beta-log', 'ronit@beta-log.example']),
    );
  });

  /**
   * A record with no name cannot be matched by name, so it must not appear —
   * otherwise the resolver would carry candidates it can never select, and an
   * ambiguity count would include people the owner was never shown.
   */
  it('skips an entity with no name', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c2'),
        kind: 'entity',
        subjectKey: 'no-name-entity',
        body: { company: 'חברה בלי איש קשר' },
      },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: BUSINESS })).toEqual([]);
  });

  it('skips a retired entity', async () => {
    const jobId = await bossJob('c3');
    await writeMemory(
      {
        jobId,
        kind: 'entity',
        subjectKey: 'gone-entity',
        body: { name: 'מישהו שהיה' },
      },
      { businessId: BUSINESS },
    );
    // `kind` is required — self-review caught it missing here.
    await retireMemories(
      { kind: 'entity', subjectKey: 'gone-entity', reason: 'בדיקה' },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: BUSINESS })).toEqual([]);
  });

  it('does not return another businesses contacts', async () => {
    await writeMemory(
      {
        jobId: await bossJob('c4'),
        kind: 'entity',
        subjectKey: 'ours',
        body: { name: 'שלנו' },
      },
      { businessId: BUSINESS },
    );

    expect(await listContacts({ businessId: 'someone-else' })).toEqual([]);
  });

  /**
   * `recallMemories` caps at MAX_RECALL because it feeds a prompt with a token
   * budget. This read feeds a matcher, and a business with more contacts than
   * that cap would silently stop being recognised past it.
   */
  it('is not capped at the recall ceiling', async () => {
    const jobId = await bossJob('c5');
    for (let i = 0; i < 25; i += 1) {
      await writeMemory(
        { jobId, kind: 'entity', subjectKey: `contact-${i}`, body: { name: `איש ${i}` } },
        { businessId: BUSINESS },
      );
    }

    expect(await listContacts({ businessId: BUSINESS })).toHaveLength(25);
  });
});
