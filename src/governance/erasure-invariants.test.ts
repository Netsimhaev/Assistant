import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { buildErasurePlan } from './erasure-plan.js';
import { executeErasure } from './erasure.js';

const BUSINESS = 'test-business';

/**
 * Distinctive enough that a match anywhere is this test's doing and not a
 * coincidence, and shaped like an address so every place that stores one
 * accepts it.
 */
const PROBE = 'zz-erase-probe-7f3a@nowhere.example';

/**
 * The three tables an erasure deliberately leaves alone (spec §5.2). Named,
 * so the scan below is a positive control: everything not on this list must
 * come back clean, including a table added next year.
 */
const SURVIVES: readonly string[] = ['audit_log', 'spend_ledger', 'signatures'];

describe('what an erasure leaves behind', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  /**
   * The test that matters, and it is the opposite of the obvious one.
   *
   * "Erase, then check the row is gone" only checks the places whoever wrote
   * it thought of. The dangerous gap is the place nobody thought of — and
   * this project has already been surprised twice by exactly that
   * (`job_plans` holds the message body; `job_authorizations` holds the typed
   * recipients).
   *
   * So: seed the probe everywhere, erase, then read the column list out of
   * `information_schema` — not out of a list written here — and demand zero
   * matches. A table added a year from now is scanned automatically, and
   * somebody who adds a store and forgets to wire erasure into it turns this
   * red without having to remember this file exists.
   */
  it('leaves the probe in no text or JSON column of any table, anywhere', async () => {
    const bundle = await installCharter(buildCharter({ version: 'probe' }), { businessId: BUSINESS });
    const job = await createJob({
      charterVersion: bundle.charterVersion,
      provenance: 'boss',
      businessId: BUSINESS,
      title: `מייל אל ${PROBE}`,
    });
    const db = getPool();

    await db.query(
      `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
       VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
      [BUSINESS, job.jobId, PROBE],
    );
    await db.query(
      `INSERT INTO job_plans (business_id, job_id, plan_hash, plan)
       VALUES ($1, $2, 'hp', $3::jsonb)`,
      [BUSINESS, job.jobId, JSON.stringify({ steps: [{ input: { to: [PROBE], body: 'שלום' } }] })],
    );
    await db.query(
      `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text)
       VALUES ('INS-probe', $1, $2, $3)`,
      [BUSINESS, job.jobId, `תשלחי אל ${PROBE}`],
    );
    await writeMemory(
      { jobId: job.jobId, kind: 'entity', subjectKey: PROBE, body: { email: PROBE } },
      { businessId: BUSINESS },
    );

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const { rows: columns } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'jsonb', 'json', 'ARRAY')`,
    );

    // An empty result set would make the loop below vacuous — zero columns
    // scanned passes with the same `[]` as zero matches found. The schema
    // has 171 such columns today; this only has to stay comfortably above
    // zero to catch the scan itself silently finding nothing, the same
    // failure mode `reading-invariants.test.ts` locks for the policy sweep.
    expect(columns.length).toBeGreaterThan(100);

    const found: string[] = [];
    for (const column of columns) {
      if (SURVIVES.includes(column.table_name)) continue;
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${column.table_name}"
          WHERE "${column.column_name}"::text LIKE $1`,
        [`%${PROBE}%`],
      );
      if (Number(rows[0]?.n ?? '0') > 0) {
        found.push(`${column.table_name}.${column.column_name}`);
      }
    }

    expect(found).toEqual([]);
  });

  /**
   * And the other direction, without which the scan above is satisfied
   * perfectly by an erasure that deletes the whole database.
   */
  it('leaves a second contact entirely intact', async () => {
    const bundle = await installCharter(buildCharter({ version: 'two' }), { businessId: BUSINESS });
    const mk = async (identifier: string, title: string): Promise<string> => {
      const job = await createJob({
        charterVersion: bundle.charterVersion,
        provenance: 'boss',
        businessId: BUSINESS,
        title,
      });
      await getPool().query(
        `INSERT INTO job_authorizations (business_id, job_id, action_class, recipients)
         VALUES ($1, $2, 'email.reply', ARRAY[$3])`,
        [BUSINESS, job.jobId, identifier],
      );
      await writeMemory(
        { jobId: job.jobId, kind: 'entity', subjectKey: identifier, body: { email: identifier } },
        { businessId: BUSINESS },
      );
      return job.jobId;
    };

    await mk(PROBE, 'probe');
    const keptJob = await mk('keeper@nowhere.example', 'keeper');

    const plan = await buildErasurePlan({ kind: 'contact', identifier: PROBE }, { businessId: BUSINESS });
    await executeErasure(plan, { businessId: BUSINESS });

    const memories = await getPool().query<{ subject_key: string }>(
      'SELECT subject_key FROM memories WHERE business_id=$1',
      [BUSINESS],
    );
    expect(memories.rows.map((r) => r.subject_key)).toEqual(['keeper@nowhere.example']);

    const auth = await getPool().query('SELECT 1 FROM job_authorizations WHERE job_id=$1', [keptJob]);
    expect(auth.rows).toHaveLength(1);
  });

  /**
   * The erasure module's own two files, and the property is about who may
   * import them, not about what they do when called. Named as a positive
   * allow list rather than a set of excluded root directories: a
   * hand-maintained `roots` list here once covered
   * orchestrator/sdk/policy/documents/charter and silently skipped
   * src/cli, src/mail, src/memory, src/util, src/db, src/audit and
   * src/config.ts — exactly the "control that covers a subset of what it
   * claims" failure this project has been burned by before. Walking the
   * whole tree and excluding by name means a directory added next year is
   * scanned by default, not skipped by default.
   */
  const ERASURE_MODULE_FILES = new Set([
    join('src', 'governance', 'erasure.ts'),
    join('src', 'governance', 'erasure-plan.ts'),
  ]);

  /**
   * Erasure must never become something a plan can invoke: an injected
   * document would say "forget what you found out about me" and the evidence
   * would go (spec §3). Checked by reading the source, because the property
   * is about who may import it, not about what it does when called.
   */
  it('is imported by nothing outside erasure.ts itself and the dashboard', async () => {
    const offenders: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (ERASURE_MODULE_FILES.has(path)) continue;
        // The dashboard is the one production consumer spec §3 permits: a
        // preview built for the owner to confirm, and the confirmed
        // execution. Matched by path segment, not by root, so a file at any
        // depth under it is exempt.
        if (path.split(/[\\/]/).includes('dashboard')) continue;
        const source = await readFile(path, 'utf8');
        if (/from\s+['"].*erasure(-plan)?\.js['"]/.test(source)) {
          offenders.push(path);
        }
      }
    };

    await walk('src');
    expect(offenders).toEqual([]);
  });

  it('names erasure in no tool table and no agent allowlist', async () => {
    const classify = await readFile('src/policy/classify.ts', 'utf8');
    const capabilities = await readFile('src/charter/capabilities.ts', 'utf8');
    for (const forbidden of ['memory.forget', 'erase', 'erasure']) {
      expect(classify.includes(`'${forbidden}'`), `classify.ts names ${forbidden}`).toBe(false);
      expect(capabilities.includes(`'${forbidden}'`), `capabilities.ts names ${forbidden}`).toBe(false);
    }
  });
});
