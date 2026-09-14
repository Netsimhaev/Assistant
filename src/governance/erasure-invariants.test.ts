import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, getPool } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { buildErasurePlan } from './erasure-plan.js';
import { executeErasure } from './erasure.js';

const BUSINESS = 'test-business';

/**
 * Distinctive enough that a match anywhere is this test's doing and not a
 * coincidence, and shaped like an address so every place that stores one
 * accepts it.
 *
 * **The underscore is load-bearing** (fix round 2, F1). `_` is an ordinary
 * character in an email local part and a WILDCARD to `LIKE`, so an anchor
 * carrying one is only found if the escaping actually works end to end —
 * `likeLiteral` prefixing it AND the statement declaring an escape character.
 * The orphan-approval predicate declared `ESCAPE ''` (a single backslash
 * inside a template literal collapses), escape processing was off, and the
 * escaped pattern matched nothing. This sweep stayed green through all of it
 * for one reason only: the probe had no wildcard in it. One character makes
 * the control able to catch that class by itself, which is the whole point of
 * seeding all twelve stores.
 */
const PROBE = 'zz_erase-probe-7f3a@nowhere.example';

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
   *
   * **"Everywhere" means all twelve content stores of spec §5.1, and it did
   * not used to** (final review, N2). The seed covered five — `jobs.title`,
   * `job_authorizations.recipients`, `job_plans.plan`,
   * `boss_instructions.text` and `memories` — so the sweep could only detect
   * a missed store that would have received a copy of one of those five
   * values. N1 was the live demonstration: an orphan `approval_requests` card
   * carrying the probe survived a contact erasure entirely, and this scan
   * stayed green because no such row was ever seeded. The seven added below
   * are the rest of the table, and the orphan card is among them, so this
   * control now detects N1 by itself.
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

    // --- The other seven stores of spec §5.1. ----------------------------
    //
    // The document chain first. It is reached from the job the way production
    // reaches it — document → reading → proposal → job — so the probe lands
    // in `documents`, `document_artifacts`, `document_readings` and
    // `proposals` through the plan's real closure and not through a shortcut
    // this test invented.
    const documentId = `DOC-probe-${Date.now()}`;
    await db.query(
      `INSERT INTO documents
         (document_id, business_id, source, original_name, media_type, sha256,
          byte_size, stored_path, status, reason)
       VALUES ($1, $2, 'manual', $3, 'text/plain', repeat('c', 64), 12, $4, 'extracted', $5)`,
      [
        documentId,
        BUSINESS,
        `הצעת מחיר ל-${PROBE}.txt`,
        `${BUSINESS}/${documentId}/original.txt`,
        `נקלט מ-${PROBE}`,
      ],
    );
    await db.query(
      `INSERT INTO document_artifacts (business_id, document_id, ordinal, kind, content, part_name)
       VALUES ($1, $2, 0, 'text', $3::jsonb, $4)`,
      [BUSINESS, documentId, JSON.stringify({ text: `צור קשר עם ${PROBE}` }), `גיליון ${PROBE}`],
    );
    const readingId = `READ-probe-${Date.now()}`;
    await db.query(
      `INSERT INTO document_readings
         (reading_id, business_id, document_id, status, content, provenance, model,
          prompt_version, brief_hash)
       VALUES ($1, $2, $3, 'read', $4::jsonb, 'boss', 'test-model', 'v1', 'hash-probe')`,
      [readingId, BUSINESS, documentId, JSON.stringify({ summary: `פנייה של ${PROBE}` })],
    );
    await db.query(
      `INSERT INTO proposals
         (proposal_id, business_id, reading_id, status, content, model, prompt_version, raw, job_id)
       VALUES ($1, $2, $3, 'proposed', $4::jsonb, 'test-model', 'v1', $5, $6)`,
      [
        `PROP-probe-${Date.now()}`,
        BUSINESS,
        readingId,
        JSON.stringify({ stance: 'act', to: PROBE }),
        `הצעה גולמית אל ${PROBE}`,
        job.jobId,
      ],
    );

    // Two approval cards: one behind the job, and one ORPHAN — `job_id` NULL,
    // the shape N1 found surviving. Both hold the address and the body.
    for (const [approvalId, jobIdOrNull] of [
      [`AP-probe-job-${Date.now()}`, job.jobId],
      [`AP-probe-orphan-${Date.now()}`, null],
    ] as Array<[string, string | null]>) {
      await db.query(
        `INSERT INTO approval_requests
           (approval_id, business_id, job_id, action_class, summary, detail, risk,
            proposed_tool, proposed_input, input_hash, expires_at, edited_input,
            decision_note, diff_vs_norm, artifacts)
         VALUES ($1, $2, $3, 'email.reply', $4, $5, $6::jsonb, 'mail.send', $7::jsonb, $8, $9,
                 $10::jsonb, $11, $12, $13::jsonb)`,
        [
          approvalId,
          BUSINESS,
          jobIdOrNull,
          `שליחת מייל אל ${PROBE}`,
          `הגוף המלא של ההודעה אל ${PROBE}`,
          JSON.stringify({ band: 'sensitive', note: PROBE }),
          JSON.stringify({ to: PROBE, body: `שלום ${PROBE}` }),
          `hash-${approvalId}`,
          new Date(Date.now() + 3600_000).toISOString(),
          JSON.stringify({ to: PROBE }),
          `הבעלים כתב על ${PROBE}`,
          `חריגה לעומת ${PROBE}`,
          JSON.stringify([{ name: PROBE }]),
        ],
      );
    }

    // The two scrubbed stores. Both survive the erasure as rows and must come
    // back holding nothing to read.
    await transition(job.jobId, {
      to: 'understand',
      actor: 'orchestrator',
      reason: `פתיחת משימה בעקבות ${PROBE}`,
      businessId: BUSINESS,
    });
    await db.query(
      `INSERT INTO job_step_results (business_id, job_id, plan_hash, step_id, external_id)
       VALUES ($1, $2, 'hp', 's1', $3)`,
      [BUSINESS, job.jobId, `msg-${PROBE}`],
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
        // Both import forms. Requiring the `from` keyword missed
        // `await import('../governance/erasure.js')` — and a dynamic import
        // is precisely how a future caller would reach a module it is not
        // supposed to name statically. No offender exists today; the
        // alternation was proved to bite by planting one in `src/util/
        // money.ts`, watching this test name the file, and restoring it.
        if (/(?:from|import\s*\()\s*['"].*erasure(-plan)?\.js['"]/.test(source)) {
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
