import { withBusiness } from '../db/pool.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePlatformPool } from '../db/platform-pool.js';
import { resetDatabase, testDb } from '../test/db.js';
import { createBusiness, getBusiness, setBusinessStatus, TenancyError } from './businesses.js';
import { listActiveBusinesses } from './platform.js';
import { createJob, transition } from '../orchestrator/jobs.js';

beforeEach(resetDatabase);
afterAll(closePlatformPool);

async function countBusinesses(): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>('SELECT count(*)::text AS n FROM businesses');
  return Number(rows[0]?.n);
}

describe('businesses registry', () => {
  it('creates and lists an active business', async () => {
    await createBusiness('alpha-shop', 'חנות אלפא');
    expect(await getBusiness('alpha-shop')).toEqual({
      businessId: 'alpha-shop',
      displayName: 'חנות אלפא',
      status: 'active',
    });
    expect(await listActiveBusinesses()).toEqual(['alpha-shop']);
  });

  it('refuses a malformed id before writing', async () => {
    for (const bad of ['Bad_ID', 'ab', 'a'.repeat(64), '__proto__']) {
      await expect(createBusiness(bad, 'שם')).rejects.toBeInstanceOf(TenancyError);
    }
    expect(await countBusinesses()).toBe(0);
  });

  it('refuses an empty name', async () => {
    await expect(createBusiness('good-id', '   ')).rejects.toBeInstanceOf(TenancyError);
    expect(await countBusinesses()).toBe(0);
  });

  it('refuses a duplicate id', async () => {
    await createBusiness('alpha-shop', 'א');
    await expect(createBusiness('alpha-shop', 'ב')).rejects.toBeInstanceOf(TenancyError);
    expect(await countBusinesses()).toBe(1);
  });

  it('suspended businesses are not listed', async () => {
    await createBusiness('alpha-shop', 'א');
    await createBusiness('beta-shop', 'ב');
    await setBusinessStatus('alpha-shop', 'suspended');
    expect(await listActiveBusinesses()).toEqual(['beta-shop']);
    expect((await getBusiness('alpha-shop'))?.status).toBe('suspended');
    await setBusinessStatus('alpha-shop', 'active');
    expect(await listActiveBusinesses()).toEqual(['alpha-shop', 'beta-shop']);
  });

  it('refuses to change the status of an unknown business', async () => {
    await expect(setBusinessStatus('nobody-here', 'suspended')).rejects.toBeInstanceOf(TenancyError);
  });

  it("job_steps rows written by transition carry the job's business_id", async () => {
    await testDb().query(
      `INSERT INTO charter_versions (charter_version, business_id, effective_from, charter,
         policy_bundle, content_hash, signed_by, signed_at, signature_method)
       VALUES ('v1', 'alpha-shop', now(), '{}', '{}', repeat('a', 64), 'p', now(), 'test')`,
    );
    const job = await withBusiness('alpha-shop', (db) => createJob(db, {
      charterVersion: 'v1',
      provenance: 'boss',
    }));
    await withBusiness('alpha-shop', (db) => transition(db, job.jobId, {
      to: 'understand',
      actor: 'system',
      reason: 'test',
    }));
    const { rows } = await testDb().query<{ business_id: string }>(
      'SELECT business_id FROM job_steps WHERE job_id = $1',
      [job.jobId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.business_id).toBe('alpha-shop');
  });
});
