import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { installCharter } from '../charter/store.js';
import { buildCharter } from '../test/fixtures.js';
import { schedulerPass } from './scheduler.js';

const BUSINESS = 'biz-sched-conduct';

describe('schedulerPass and the conductor', () => {
  beforeEach(async () => {
    await resetDatabase();
    await installCharter(buildCharter(), { businessId: BUSINESS });
  });

  it('scans the inbox when one is configured', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'sched-inbox-'));
    const documentRoot = await mkdtemp(join(tmpdir(), 'sched-root-'));
    await writeFile(join(inbox, 'note.txt'), 'שלום', 'utf8');

    const result = await schedulerPass({
      businessId: BUSINESS,
      inbox,
      documentRoot,
      // No reader injected: the pass must not call a model in this test, so
      // the ceiling is set to zero and only the scan runs.
      readsPerDay: 0,
    });

    expect(result.scan?.ingested).toBe(1);
    const { rows } = await getPool().query(`SELECT 1 FROM documents WHERE business_id = $1`, [
      BUSINESS,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('does not scan and does not fail when no inbox is configured', async () => {
    const result = await schedulerPass({ businessId: BUSINESS, readsPerDay: 0 });
    expect(result.scan).toBeNull();
  });
});
