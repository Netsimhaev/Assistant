/**
 * Migration 081 — the database half of deleting a whole business.
 *
 * `delete_business_rows(p_business)` is a SECURITY DEFINER function, owned by
 * the table owner and executable only by `assistant_platform_group`. It finds
 * every base table in `public` with a `business_id` column at runtime (never a
 * list), deletes the business's rows from each in rounds — a table a foreign
 * key blocked is retried next round — and raises when a round makes no
 * progress. `audit_log`'s append-only trigger lets exactly that function
 * delete: the owner, with `app.deleting_business` naming the row's business.
 *
 * Seeding: business A gets a realistic graph through the production writers
 * (charter, job with steps, approval, memory, mail, external event, an audit
 * chain with a spend row on it, a signed document) AND one generic row in
 * every business table (`seedEveryTable`), so the delete is shown to reach
 * every table, not only the ones this file thought of. Business B — whose id
 * starts with A's id — gets the realistic graph only, and must come out
 * exactly as it went in.
 */
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, withBusinessTransaction, type Queryable } from '../db/pool.js';
import { closePlatformPool, withPlatform } from '../db/platform-pool.js';
import { ensureSchema, registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { seedEveryTable } from '../test/seed-every-table.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { createJob, transition } from '../orchestrator/jobs.js';
import { writeMemory } from '../memory/store.js';
import { appendAudit } from '../audit/log.js';
import { canonicalHash } from '../util/canonical.js';
import { TEST_PLATFORM_USER } from '../config.js';

const BIZ_A = 'del-biz-a';
/** Starts with A's id on purpose: a prefix match anywhere would take its rows. */
const BIZ_B = 'del-biz-a-2';

/**
 * Every base table in `public` with NO `business_id` column, each with why it
 * may have none. A per-business table created without the column would be
 * skipped by the delete silently; this list makes it fail here by name.
 */
const NO_BUSINESS_ID: Readonly<Record<string, string>> = {
  schema_migrations: "the migrator's own bookkeeping",
  platform_credentials: "the server's OAuth client secrets, not a business's",
  server_key_state: "the server's one master-key state row",
  dashboard_unknown_user_throttle: 'one server-wide bucket for logins to unknown addresses',
  platform_staff: "the company's technicians",
  platform_staff_sessions: "a technician's sessions",
  platform_staff_devices: "a technician's trusted devices",
  platform_staff_links: "a technician's invite and reset links",
  platform_staff_unknown_login_throttle: "the panel's one server-wide unknown-login bucket",
};

/**
 * Every table in `public` (relkind r/p) with whether it has a live
 * `business_id` column — read from pg_catalog, the same catalog query the
 * function runs, not information_schema (which filters by privilege).
 */
async function publicTables(db: Queryable): Promise<Array<{ name: string; hasBusinessId: boolean }>> {
  const { rows } = await db.query<{ name: string; has_bid: boolean }>(
    `SELECT c.relname::text AS name,
            EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'business_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) AS has_bid
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY 1`,
  );
  return rows.map((r) => ({ name: r.name, hasBusinessId: r.has_bid }));
}

/** Every table in `public` with a `business_id`, minus `businesses` itself. */
async function businessTables(db: Queryable): Promise<string[]> {
  return (await publicTables(db)).filter((t) => t.hasBusinessId && t.name !== 'businesses').map((t) => t.name);
}

/** Row counts of `businessId` in every table, on the migrator (a superuser in tests). */
async function countsFor(tables: readonly string[], businessId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE business_id = $1`,
      [businessId],
    );
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

let staffId = '';

/** A realistic graph for one business, through the production writers where there are some. */
async function seedRealistic(businessId: string): Promise<void> {
  const db = testDb();
  const bundle = await withBusiness(businessId, (bdb) =>
    installCharter(bdb, buildCharter({ version: `v-${businessId}` })),
  );
  const job = await withBusiness(businessId, (bdb) =>
    createJob(bdb, { charterVersion: bundle.charterVersion, provenance: 'boss', title: 'משימה' }),
  );
  await withBusiness(businessId, (bdb) =>
    transition(bdb, job.jobId, { to: 'understand', actor: 'orchestrator', reason: 't' }),
  );
  await db.query(
    `INSERT INTO job_plans (business_id, job_id, plan_hash, plan) VALUES ($1, $2, 'hp', '{"steps":[]}'::jsonb)`,
    [businessId, job.jobId],
  );
  await db.query(
    `INSERT INTO boss_instructions (instruction_id, business_id, job_id, text, text_origin)
     VALUES ($1, $2, $3, 'תשלחי מייל', 'typed')`,
    [`INS-${ulid()}`, businessId, job.jobId],
  );
  await db.query(
    `INSERT INTO approval_requests
       (approval_id, business_id, job_id, action_class, summary, detail, risk,
        proposed_tool, proposed_input, input_hash, expires_at)
     VALUES ($1, $2, $3, 'email.reply', 'סיכום', 'פירוט', '{}'::jsonb, 'mail.send', '{}'::jsonb, 'h', now() + interval '1 hour')`,
    [`AP-${ulid()}`, businessId, job.jobId],
  );
  await withBusiness(businessId, (bdb) =>
    writeMemory(bdb, { jobId: job.jobId, kind: 'entity', subjectKey: 'dana', body: { name: 'דנה' } }),
  );
  await db.query(
    `INSERT INTO mail_messages
       (mail_id, business_id, provider_message_id, thread_id, from_address, subject, received_at, body_text, state)
     VALUES ($1, $2, $3, 'th', 'dana@example.com', 'נושא', now(), 'גוף', 'triaged')`,
    [`M-${ulid()}`, businessId, `pm-${ulid()}`],
  );
  await db.query(
    `INSERT INTO external_events (business_id, event_id, system_id, source, event_type, item_hash, fields)
     VALUES ($1, $2, 'crm', 'webhook', 'customer.created', $3, '{}'::jsonb)`,
    [businessId, `XE-${ulid()}`, `h-${ulid()}`],
  );
  // A signed document: `signatures` holds it with ON DELETE RESTRICT, so the
  // document can only go in a round after its signature.
  const documentId = `DOC-${ulid()}`;
  await db.query(
    `INSERT INTO documents
       (document_id, business_id, source, original_name, media_type, sha256, byte_size, stored_path, status)
     VALUES ($1, $2, 'manual', 'a.txt', 'text/plain', repeat('c', 64), 1, $3, 'extracted')`,
    [documentId, businessId, `${businessId}/${documentId}/original.txt`],
  );
  await db.query(
    `INSERT INTO signatures (signature_id, business_id, document_id, signed_sha256, approval_id, signed_by)
     VALUES ($1, $2, $3, repeat('c', 64), $4, 'owner')`,
    [`SIG-${ulid()}`, businessId, documentId, `AP-${ulid()}`],
  );
  // An audit chain, and a spend row that references its first link (NO ACTION):
  // the audit rows can only go after the spend row.
  let firstSeq: bigint | null = null;
  for (const reason of ['one', 'two', 'three']) {
    const appended = await withBusiness(businessId, (bdb) =>
      appendAudit(bdb, {
        actor: 'orchestrator',
        kind: 'decision',
        charterVersion: bundle.charterVersion,
        provenance: 'boss',
        inputHash: canonicalHash({ reason }),
        reason,
      }),
    );
    firstSeq ??= appended.seq;
  }
  await db.query(
    `INSERT INTO spend_ledger (business_id, job_id, action_class, amount_minor, currency, audit_seq, idempotency_key)
     VALUES ($1, $2, 'purchase.place', 100, 'ILS', $3, $4)`,
    [businessId, job.jobId, String(firstSeq), `k-${ulid()}`],
  );
  await db.query(
    `INSERT INTO platform_activity_log (staff_id, action, business_id, detail) VALUES ($1, 'business-create', $2, '{}'::jsonb)`,
    [staffId, businessId],
  );
}

async function deleteRows(businessId: string): Promise<Array<{ table_name: string; deleted: bigint }>> {
  return withPlatform(async (db) => {
    const { rows } = await db.query<{ table_name: string; deleted: bigint }>(
      'SELECT table_name, deleted FROM delete_business_rows($1)',
      [businessId],
    );
    return rows;
  });
}

let tables: string[] = [];

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDatabase();
  await registerBusiness(BIZ_A, 'suspended');
  await registerBusiness(BIZ_B, 'active');
  staffId = `ST-${ulid()}`;
  await testDb().query(
    `INSERT INTO platform_staff (staff_id, login, display_name) VALUES ($1, 'tech@example.com', 'טכנאי')`,
    [staffId],
  );
  tables = await businessTables(testDb());
});

afterAll(async () => {
  await closePlatformPool();
  await closePool();
});

describe('delete_business_rows (migration 081)', () => {
  it('finds the business tables (an empty scan is not a control)', () => {
    expect(tables.length).toBeGreaterThan(50);
    expect(tables).toContain('audit_log');
    expect(tables).toContain('platform_activity_log');
  });

  it("removes every row of the business from every table, and none of another business's", async () => {
    await seedRealistic(BIZ_A);
    await seedRealistic(BIZ_B);
    await seedEveryTable(tables, BIZ_A);

    const beforeA = await countsFor(tables, BIZ_A);
    // Every business table holds a row of A, so the delete is shown to reach each one.
    expect(Object.entries(beforeA).filter(([, n]) => n === 0).map(([t]) => t)).toEqual([]);
    const beforeB = await countsFor(tables, BIZ_B);

    const returned = await deleteRows(BIZ_A);

    const afterA = await countsFor(tables, BIZ_A);
    expect(Object.entries(afterA).filter(([, n]) => n > 0).map(([t]) => t)).toEqual([]);
    expect(await countsFor(tables, BIZ_B)).toEqual(beforeB);

    const names = returned.map((r) => r.table_name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const t of ['audit_log', 'spend_ledger', 'signatures', 'documents', 'jobs', 'memories', 'platform_activity_log']) {
      expect(names).toContain(t);
    }
    for (const r of returned) expect(r.deleted > 0n).toBe(true);

    // The registry row is the caller's to delete, last.
    const { rows } = await testDb().query('SELECT 1 FROM businesses WHERE business_id = $1', [BIZ_A]);
    expect(rows).toHaveLength(1);
  });

  it('reaches a business table created after the migration', async () => {
    const probe = 'del_probe_later_table';
    await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    await testDb().query(`CREATE TABLE ${probe} (business_id TEXT NOT NULL, note TEXT)`);
    try {
      await testDb().query(`INSERT INTO ${probe} VALUES ($1, 'a'), ($2, 'b')`, [BIZ_A, BIZ_B]);
      const returned = await deleteRows(BIZ_A);
      expect(returned).toContainEqual({ table_name: probe, deleted: 1n });
      const { rows } = await testDb().query<{ business_id: string }>(`SELECT business_id FROM ${probe}`);
      expect(rows.map((r) => r.business_id)).toEqual([BIZ_B]);
    } finally {
      await testDb().query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });

  it('raises, naming the table, when a round makes no progress — and deletes nothing', async () => {
    await seedRealistic(BIZ_A);
    const parent = 'del_probe_parent';
    const child = 'del_probe_child';
    await testDb().query(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`);
    // The child has no business_id, so nothing ever deletes it, and it holds the parent.
    await testDb().query(`CREATE TABLE ${parent} (business_id TEXT NOT NULL, id TEXT PRIMARY KEY)`);
    await testDb().query(`CREATE TABLE ${child} (parent_id TEXT REFERENCES ${parent} (id))`);
    try {
      await testDb().query(`INSERT INTO ${parent} VALUES ($1, 'p1')`, [BIZ_A]);
      await testDb().query(`INSERT INTO ${child} VALUES ('p1')`);
      const before = await countsFor(tables, BIZ_A);

      await expect(deleteRows(BIZ_A)).rejects.toThrow(`business deletion incomplete: ${parent}`);

      // One transaction: the failure leaves every other table as it was.
      expect(await countsFor(tables, BIZ_A)).toEqual(before);
    } finally {
      await testDb().query(`DROP TABLE IF EXISTS ${child}; DROP TABLE IF EXISTS ${parent}`);
    }
  });

  it('the app account cannot call it', async () => {
    await seedRealistic(BIZ_A);
    await expect(
      withBusiness(BIZ_A, (db) => db.query('SELECT * FROM delete_business_rows($1)', [BIZ_A])),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await testDb().query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE business_id = $1',
      [BIZ_A],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('is executable only by the platform group, and runs as the owner of audit_log', async () => {
    const { rows } = await testDb().query<{
      app: boolean;
      platform: boolean;
      public_acl: boolean;
      definer: boolean;
      same_owner: boolean;
    }>(
      `SELECT has_function_privilege('assistant_app', 'delete_business_rows(text)', 'EXECUTE') AS app,
              has_function_privilege('assistant_platform_group', 'delete_business_rows(text)', 'EXECUTE') AS platform,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_acl,
              p.prosecdef AS definer,
              p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'public.audit_log'::regclass) AS same_owner
         FROM pg_proc p WHERE p.oid = 'public.delete_business_rows(text)'::regprocedure`,
    );
    expect(rows[0]).toEqual({ app: false, platform: true, public_acl: false, definer: true, same_owner: true });
  });

  it('the app account holds no DELETE on audit_log, even with app.deleting_business set', async () => {
    await seedRealistic(BIZ_A);
    await expect(
      withBusinessTransaction(BIZ_A, async (db) => {
        await db.query(`SELECT set_config('app.deleting_business', $1, true)`, [BIZ_A]);
        await db.query('DELETE FROM audit_log');
      }),
    ).rejects.toThrow(/permission denied for table audit_log/);
    const { rows } = await testDb().query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE business_id = $1',
      [BIZ_A],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('the owner still cannot UPDATE audit_log, nor DELETE it without the matching setting', async () => {
    await seedRealistic(BIZ_A);
    await expect(
      testDb().query('UPDATE audit_log SET reason = reason WHERE business_id = $1', [BIZ_A]),
    ).rejects.toThrow(/audit_log is append-only: UPDATE/);
    // UPDATE stays refused even with the setting that lets a DELETE through.
    const client = await testDb().connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.deleting_business', $1, true)`, [BIZ_A]);
      await expect(
        client.query('UPDATE audit_log SET reason = reason WHERE business_id = $1', [BIZ_A]),
      ).rejects.toThrow(/audit_log is append-only: UPDATE/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.deleting_business', $1, true)`, [BIZ_B]);
      await expect(
        client.query('DELETE FROM audit_log WHERE business_id = $1', [BIZ_A]),
      ).rejects.toThrow(/audit_log is append-only: DELETE/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(
      testDb().query('DELETE FROM audit_log WHERE business_id = $1', [BIZ_A]),
    ).rejects.toThrow(/audit_log is append-only: DELETE/);
  });

  it("accepts status 'deleting' and the pass heartbeat columns, and refuses any other status", async () => {
    await testDb().query(
      `UPDATE businesses SET status = 'deleting', pass_started_at = now(), pass_finished_at = now()
        WHERE business_id = $1`,
      [BIZ_A],
    );
    await expect(
      testDb().query(`UPDATE businesses SET status = 'gone' WHERE business_id = $1`, [BIZ_A]),
    ).rejects.toThrow(/businesses_status_check/);
  });

  it('inventory lock: every table without business_id is a named server table', async () => {
    const rows = await publicTables(testDb());
    expect(rows.length).toBeGreaterThan(50);
    const without = rows.filter((r) => !r.hasBusinessId).map((r) => r.name);
    expect(without).toEqual(Object.keys(NO_BUSINESS_ID).sort());
  });
  it('refuses a NULL, empty or malformed business id before touching anything', async () => {
    await seedRealistic(BIZ_A);
    const before = await countsFor(tables, BIZ_A);
    for (const bad of [null, '', 'ab', 'Del-Biz-A', 'del_biz_a', 'del-biz-a%', `${'a'.repeat(64)}`]) {
      await expect(
        withPlatform((db) => db.query('SELECT * FROM delete_business_rows($1)', [bad])),
        String(bad),
      ).rejects.toThrow('delete_business_rows: not a business id');
    }
    expect(await countsFor(tables, BIZ_A)).toEqual(before);
  });

  it('the app account holds neither UPDATE nor DELETE on audit_log', async () => {
    const { rows } = await testDb().query<{ upd: boolean; del: boolean; ins: boolean }>(
      `SELECT has_table_privilege('assistant_app', 'public.audit_log', 'UPDATE') AS upd,
              has_table_privilege('assistant_app', 'public.audit_log', 'DELETE') AS del,
              has_table_privilege('assistant_app', 'public.audit_log', 'INSERT') AS ins`,
    );
    expect(rows[0]).toEqual({ upd: false, del: false, ins: true });
  });

  /**
   * The attack fix round 1 closed: the app login shadows `pg_class` with a
   * temp table whose only row names itself as audit_log's owner, puts pg_temp
   * first on its search_path and sets `app.deleting_business` itself. With an
   * unqualified catalog name in the trigger and the app's DELETE grant, that
   * deleted the chain. Both the pinned/qualified trigger and the revoke stand
   * against it; this test fails if both are undone.
   */
  it('the app login cannot delete audit_log by shadowing pg_class with a temp table', async () => {
    await seedRealistic(BIZ_A);
    await expect(
      withBusinessTransaction(BIZ_A, async (db) => {
        await db.query('CREATE TEMP TABLE pg_class (oid oid, relowner oid) ON COMMIT DROP');
        await db.query(
          `INSERT INTO pg_temp.pg_class
           SELECT 'public.audit_log'::regclass::oid, r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
        );
        await db.query(`SELECT set_config('search_path', 'pg_temp, pg_catalog, public', true)`);
        await db.query(`SELECT set_config('app.deleting_business', $1, true)`, [BIZ_A]);
        await db.query('DELETE FROM audit_log');
      }),
    ).rejects.toThrow(/permission denied for table audit_log|audit_log is append-only: DELETE/);
    const { rows } = await testDb().query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE business_id = $1',
      [BIZ_A],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  /**
   * In tests the migrator is a superuser, and superusers bypass even FORCEd
   * row level security — so the function's `set_config('app.business_id', …)`
   * and the trigger's owner branch are exercised here under a NON-superuser
   * owner, the shape production has. One transaction on the migrator, rolled
   * back: a NOSUPERUSER NOBYPASSRLS role takes ownership of the function and of
   * audit_log, is granted SELECT and DELETE on every table (RLS then applies to
   * it on every one of them, FORCEd on audit_log, which it owns), and the
   * platform login calls the function.
   */
  it('works under a non-superuser owner: RLS is matched and the trigger lets its owner delete', async () => {
    await seedRealistic(BIZ_A);
    await seedRealistic(BIZ_B);
    const owner = `del_probe_owner_${ulid().toLowerCase()}`;
    const client = await testDb().connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT ${owner} TO current_user`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${owner}`);
      await client.query(`GRANT SELECT, DELETE ON ALL TABLES IN SCHEMA public TO ${owner}`);
      await client.query(`ALTER TABLE audit_log OWNER TO ${owner}`);
      await client.query(`ALTER FUNCTION delete_business_rows(text) OWNER TO ${owner}`);
      const { rows: probe } = await client.query<{ su: boolean; bypass: boolean }>(
        `SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = $1`,
        [owner],
      );
      expect(probe[0]).toEqual({ su: false, bypass: false });

      await client.query(`SET LOCAL ROLE ${TEST_PLATFORM_USER}`);
      const { rows: returned } = await client.query<{ table_name: string }>(
        'SELECT table_name FROM delete_business_rows($1)',
        [BIZ_A],
      );
      await client.query('RESET ROLE');
      expect(returned.map((r) => r.table_name)).toContain('audit_log');

      for (const [business, expected] of [[BIZ_A, 0], [BIZ_B, 3]] as const) {
        const { rows } = await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM audit_log WHERE business_id = $1',
          [business],
        );
        expect({ business, n: Number(rows[0]?.n) }).toEqual({ business, n: expected });
      }
      for (const table of tables) {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE business_id = $1`,
          [BIZ_A],
        );
        expect({ table, n: Number(rows[0]?.n) }).toEqual({ table, n: 0 });
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // Rolled back: the role, the ownership and the rows are as they were.
    const { rows } = await testDb().query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE business_id = $1',
      [BIZ_A],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });
});
