/**
 * Deleting a whole business — the tenancy half (spec 2026-11-19, plan Task 2):
 * the guards (head admin, suspended, exact name, no pass in flight), the row
 * step on the platform pool, the file step, the registry row last, and an id
 * that can be reused only once nothing of the old business is left.
 *
 * Business `acme` is deleted; business `acme-2` — whose id starts with
 * `acme` on purpose — must come out exactly as it went in, rows and files.
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { closePlatformPool } from '../db/platform-pool.js';
import { ensureSchema, registerBusiness, resetDatabase, testDb } from '../test/db.js';
import { seedEveryTable } from '../test/seed-every-table.js';
import {
  DELETION_REFUSAL_HE,
  deleteBusinessFiles,
  deleteBusinessRows,
  finishDeletion,
  passInFlight,
  recordPassEnd,
  recordPassStart,
} from './business-deletion.js';
import { BusinessExistsError, createBusiness, getBusiness, TenancyError } from './businesses.js';
import { businessFolders } from './paths.js';

const ACME = 'acme';
const ACME2 = 'acme-2';
const ACME_NAME = 'Acme Shop';

const mutableConfig = config as { documentRoot: string; documentInboxRoot: string | null };
const original = { documentRoot: config.documentRoot, documentInboxRoot: config.documentInboxRoot };
let tempRoots: string[] = [];

let headId = '';
let tables: string[] = [];

async function businessTables(): Promise<string[]> {
  const { rows } = await testDb().query<{ name: string }>(
    `SELECT c.relname::text AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'businesses'
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'business_id'
                       AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

async function totalRows(businessId: string): Promise<Record<string, number>> {
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

async function sumRows(businessId: string): Promise<number> {
  return Object.values(await totalRows(businessId)).reduce((a, b) => a + b, 0);
}

async function statusOf(businessId: string): Promise<string | null> {
  const { rows } = await testDb().query<{ status: string }>('SELECT status FROM businesses WHERE business_id = $1', [
    businessId,
  ]);
  return rows[0]?.status ?? null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function putFile(path: string, body = 'x'): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

function folders(businessId: string): { document: string; inbox: string; save: string } {
  const f = businessFolders(businessId);
  if (f.inbox === null || f.save === null) throw new Error('the test sets every root');
  return { document: f.document, inbox: f.inbox, save: f.save };
}

beforeAll(async () => {
  await ensureSchema();
  const docRoot = await mkdtemp(join(tmpdir(), 'bizdel-doc-'));
  const inboxRoot = await mkdtemp(join(tmpdir(), 'bizdel-inbox-'));
  tempRoots = [docRoot, inboxRoot];
  mutableConfig.documentRoot = docRoot;
  mutableConfig.documentInboxRoot = inboxRoot;
  if (config.documentSaveRoot === null) throw new Error('DOCUMENT_SAVE_ROOT is set for tests (vitest.config.ts)');
});

beforeEach(async () => {
  await resetDatabase();
  await testDb().query(
    `INSERT INTO businesses (business_id, display_name, status, suspended_at) VALUES ($1, $2, 'suspended', now())`,
    [ACME, ACME_NAME],
  );
  await registerBusiness(ACME2, 'active');
  headId = `ST-${ulid()}`;
  await testDb().query(
    `INSERT INTO platform_staff (staff_id, login, display_name, is_head) VALUES ($1, $2, 'מנהלת', true)`,
    [headId, `head-${ulid().toLowerCase()}@example.com`],
  );
  tables = await businessTables();
  for (const id of [ACME, ACME2]) {
    for (const f of Object.values(folders(id))) await rm(f, { recursive: true, force: true });
  }
});

afterAll(async () => {
  for (const id of [ACME, ACME2]) await rm(folders(id).save, { recursive: true, force: true }).catch(() => {});
  mutableConfig.documentRoot = original.documentRoot;
  mutableConfig.documentInboxRoot = original.documentInboxRoot;
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  await closePlatformPool();
  await closePool();
});

describe('businessFolders', () => {
  it('builds each folder by segment under its root, so acme and acme-2 never share one', () => {
    const a = folders(ACME);
    const b = folders(ACME2);
    expect(a.document).toBe(join(config.documentRoot, ACME));
    expect(a.inbox).toBe(join(config.documentInboxRoot ?? '', ACME));
    expect(a.save).toBe(join(config.documentSaveRoot ?? '', ACME));
    expect(b.document).toBe(join(config.documentRoot, ACME2));
    expect(relative(a.document, b.document).startsWith('..')).toBe(true);
  });

  it('refuses a malformed id', () => {
    expect(() => businessFolders('../x')).toThrow(/invalid business id/);
  });
});

describe('the pass heartbeat (Ruling 4)', () => {
  it('a started pass is in flight until it ends', async () => {
    expect(await passInFlight(ACME)).toBe(false);
    await recordPassStart(ACME);
    expect(await passInFlight(ACME)).toBe(true);
    await recordPassEnd(ACME);
    expect(await passInFlight(ACME)).toBe(false);
    // Another business's pass is not this one's.
    await recordPassStart(ACME2);
    expect(await passInFlight(ACME)).toBe(false);
  });

  it('a pass started more than 30 minutes ago and never ended no longer counts', async () => {
    await testDb().query(
      `UPDATE businesses SET pass_started_at = now() - interval '31 minutes', pass_finished_at = NULL WHERE business_id = $1`,
      [ACME],
    );
    expect(await passInFlight(ACME)).toBe(false);
  });

  it('an unknown business has no pass in flight', async () => {
    expect(await passInFlight('nobody-here')).toBe(false);
  });
});

describe('deleteBusinessRows — refusals', () => {
  beforeEach(async () => {
    const { failed } = await seedEveryTable(tables, ACME);
    expect(failed).toEqual([]);
  });

  async function expectRefused(
    input: { businessId?: string; staffId?: string; typedName?: string },
    refusal: string,
  ): Promise<void> {
    const before = await sumRows(ACME);
    expect(before).toBeGreaterThan(0);
    const result = await deleteBusinessRows({
      businessId: input.businessId ?? ACME,
      staffId: input.staffId ?? headId,
      typedName: input.typedName ?? ACME_NAME,
    });
    expect(result).toEqual({ ok: false, refusal });
    expect(await sumRows(ACME)).toBe(before);
    expect(await statusOf(ACME)).not.toBe('deleting');
  }

  it('refuses a staff member who is not a head admin', async () => {
    const plain = `ST-${ulid()}`;
    await testDb().query(`INSERT INTO platform_staff (staff_id, login, display_name) VALUES ($1, $2, 'טכנאי')`, [
      plain,
      `tech-${ulid().toLowerCase()}@example.com`,
    ]);
    await expectRefused({ staffId: plain }, 'not_head');
  });

  it('refuses a head admin whose head role was removed after the page was loaded', async () => {
    await testDb().query('UPDATE platform_staff SET is_head = false WHERE staff_id = $1', [headId]);
    await expectRefused({}, 'not_head');
  });

  it('refuses a head admin who was removed', async () => {
    await testDb().query('UPDATE platform_staff SET removed_at = now() WHERE staff_id = $1', [headId]);
    await expectRefused({}, 'not_head');
  });

  it('refuses an active business even with the right name', async () => {
    await testDb().query(`UPDATE businesses SET status = 'active', suspended_at = NULL WHERE business_id = $1`, [ACME]);
    await expectRefused({}, 'not_suspended');
  });

  it('refuses a business already being deleted', async () => {
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [ACME]);
    const before = await sumRows(ACME);
    const result = await deleteBusinessRows({ businessId: ACME, staffId: headId, typedName: ACME_NAME });
    expect(result).toEqual({ ok: false, refusal: 'not_suspended' });
    expect(await sumRows(ACME)).toBe(before);
  });

  it('refuses a name in another case, with a doubled inner space, or with a hidden mark', async () => {
    await expectRefused({ typedName: 'ACME SHOP' }, 'name_mismatch');
    await expectRefused({ typedName: 'acme shop' }, 'name_mismatch');
    await expectRefused({ typedName: 'Acme  Shop' }, 'name_mismatch');
    await expectRefused({ typedName: `${ACME_NAME}‏` }, 'name_mismatch');
    await expectRefused({ typedName: `Acme​Shop` }, 'name_mismatch');
    await expectRefused({ typedName: ACME }, 'name_mismatch');
    await expectRefused({ typedName: '' }, 'name_mismatch');
  });

  it('refuses while a pass is in flight', async () => {
    await testDb().query(
      `UPDATE businesses SET pass_started_at = now(), pass_finished_at = NULL WHERE business_id = $1`,
      [ACME],
    );
    await expectRefused({}, 'pass_in_flight');
  });

  it('refuses an unknown id, and a malformed one', async () => {
    await expectRefused({ businessId: 'no-such-biz' }, 'unknown_business');
    await expectRefused({ businessId: '../acme' }, 'unknown_business');
  });

  it('has a plain Hebrew message for every refusal', () => {
    expect(DELETION_REFUSAL_HE.name_mismatch).toBe('השם שהוקלד אינו תואם בדיוק את שם העסק.');
    for (const message of Object.values(DELETION_REFUSAL_HE)) expect(message).toMatch(/[֐-׿]/);
    expect(Object.keys(DELETION_REFUSAL_HE).sort()).toEqual(
      ['name_mismatch', 'not_head', 'not_suspended', 'pass_in_flight', 'unknown_business'].sort(),
    );
  });
});

describe('deleteBusinessRows — a successful run', () => {
  it("removes every row of the business, marks it deleting, and leaves acme-2's rows as they were", async () => {
    // The generic seeder's keys are not unique across businesses. acme-2 is
    // seeded FIRST and in full, so it owns every parent row; acme's rows that
    // collided are simply absent, and acme's children that point at an
    // acme-2 parent go without touching it (a cascade runs parent to child).
    // Table-by-table isolation is proven in business-deletion-sql.test.ts.
    expect((await seedEveryTable(tables, ACME2)).failed).toEqual([]);
    await seedEveryTable(tables, ACME);
    const beforeA = await totalRows(ACME);
    expect(beforeA['audit_log']).toBeGreaterThan(0);
    expect(Object.values(beforeA).filter((n) => n > 0).length).toBeGreaterThan(20);
    const beforeB = await totalRows(ACME2);

    // A pass that never ended, 31 minutes ago, does not block.
    await testDb().query(
      `UPDATE businesses SET pass_started_at = now() - interval '31 minutes', pass_finished_at = NULL WHERE business_id = $1`,
      [ACME],
    );
    // Only the ends of the typed name are trimmed.
    const result = await deleteBusinessRows({ businessId: ACME, staffId: headId, typedName: `  ${ACME_NAME}  ` });
    if (!result.ok) throw new Error(`refused: ${result.refusal}`);
    expect(result.tables.length).toBeGreaterThan(10);
    for (const t of result.tables) expect(t.deleted).toBeGreaterThan(0);
    expect(result.tables.map((t) => t.table)).toContain('audit_log');

    const afterA = await totalRows(ACME);
    expect(Object.entries(afterA).filter(([, n]) => n > 0)).toEqual([]);
    expect(await totalRows(ACME2)).toEqual(beforeB);
    expect(await statusOf(ACME)).toBe('deleting');
    expect(await statusOf(ACME2)).toBe('active');
  });

  it('writes no activity-log row and no audit row of its own', async () => {
    const result = await deleteBusinessRows({ businessId: ACME, staffId: headId, typedName: ACME_NAME });
    expect(result.ok).toBe(true);
    const { rows } = await testDb().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM platform_activity_log) + (SELECT count(*) FROM audit_log) AS n`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('deleteBusinessFiles', () => {
  async function seedFiles(): Promise<void> {
    const a = folders(ACME);
    const b = folders(ACME2);
    await putFile(join(a.document, 'DOC-1', 'original.txt'));
    await putFile(join(a.document, 'produced-copy.pdf'));
    await putFile(join(a.inbox, 'working', 'scan.pdf'));
    await putFile(join(b.document, 'DOC-2', 'original.txt'));
    await putFile(join(b.inbox, 'working', 'other.pdf'));
    await putFile(join(a.save, 'owner-copy.docx'));
  }

  it("removes acme's document and inbox folders, and nothing of acme-2 nor acme's save folder", async () => {
    await seedFiles();
    const result = await deleteBusinessFiles(ACME);
    expect(result).toEqual({ removed: 3, failed: [] });
    expect(await exists(folders(ACME).document)).toBe(false);
    expect(await exists(folders(ACME).inbox)).toBe(false);
    expect(await exists(join(folders(ACME).save, 'owner-copy.docx'))).toBe(true);
    expect(await exists(join(folders(ACME2).document, 'DOC-2', 'original.txt'))).toBe(true);
    expect(await exists(join(folders(ACME2).inbox, 'working', 'other.pdf'))).toBe(true);
  });

  it('is a no-op on missing folders', async () => {
    expect(await deleteBusinessFiles(ACME)).toEqual({ removed: 0, failed: [] });
  });

  it('reports a failure by a path relative to its root, never an absolute server path', async () => {
    await seedFiles();
    const docFolder = folders(ACME).document;
    const result = await deleteBusinessFiles(ACME, {
      rm: async (path, options) => {
        if (path === docFolder) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        await rm(path, options);
      },
    });
    expect(result.removed).toBe(1);
    expect(result.failed).toEqual([`DOCUMENT_ROOT/${ACME}`]);
    for (const f of result.failed) {
      for (const root of tempRoots) expect(f.includes(root)).toBe(false);
    }
    expect(await exists(folders(ACME).inbox)).toBe(false);
    expect(await exists(docFolder)).toBe(true);
  });
});

describe('finishDeletion', () => {
  it('refuses while a folder exists, then removes the registry row', async () => {
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [ACME]);
    await putFile(join(folders(ACME).inbox, 'a.txt'));
    expect(await finishDeletion(ACME)).toBe(false);
    expect(await statusOf(ACME)).toBe('deleting');

    await rm(folders(ACME).inbox, { recursive: true, force: true });
    await mkdir(folders(ACME).document, { recursive: true }); // even an empty folder is still a folder
    expect(await finishDeletion(ACME)).toBe(false);

    await rm(folders(ACME).document, { recursive: true, force: true });
    // The save folder is not part of the check.
    await putFile(join(folders(ACME).save, 'kept.docx'));
    expect(await finishDeletion(ACME)).toBe(true);
    expect(await statusOf(ACME)).toBeNull();
    expect(await statusOf(ACME2)).toBe('active');
  });

  it('does not remove a business that is not being deleted', async () => {
    expect(await finishDeletion(ACME)).toBe(false);
    expect(await statusOf(ACME)).toBe('suspended');
  });
});

describe('createBusiness — reusing a deleted id', () => {
  it('is refused while the old business is still being deleted', async () => {
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [ACME]);
    const err = await createBusiness(ACME, 'חדש').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect(err).not.toBeInstanceOf(BusinessExistsError);
    expect((err as Error).message).toMatch(/[֐-׿]/);
    expect((err as Error).message).toMatch(/מחיקה/);
    expect(await statusOf(ACME)).toBe('deleting');
  });

  it('is refused while the save folder holds a file, and allowed once it is empty', async () => {
    await testDb().query('DELETE FROM businesses WHERE business_id = $1', [ACME]);
    await putFile(join(folders(ACME).save, 'nested', 'left.docx'));
    // acme-2's files never block acme.
    await putFile(join(folders(ACME2).document, 'x.txt'));

    const err = await createBusiness(ACME, 'חדש').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TenancyError);
    expect((err as Error).message).toMatch(/[֐-׿]/);
    expect(await getBusiness(ACME)).toBeNull();

    await rm(join(folders(ACME).save, 'nested', 'left.docx'));
    // Empty folders are left behind on purpose: an empty folder does not block.
    expect(await readdir(folders(ACME).save)).toEqual(['nested']);
    await createBusiness(ACME, 'חדש');
    expect(await getBusiness(ACME)).toEqual({ businessId: ACME, displayName: 'חדש', status: 'active' });
  });

  it('is refused while the document or the inbox folder holds a file', async () => {
    await testDb().query('DELETE FROM businesses WHERE business_id = $1', [ACME]);
    await putFile(join(folders(ACME).document, 'a.txt'));
    await expect(createBusiness(ACME, 'חדש')).rejects.toBeInstanceOf(TenancyError);
    await rm(folders(ACME).document, { recursive: true, force: true });
    await putFile(join(folders(ACME).inbox, 'working', 'b.txt'));
    await expect(createBusiness(ACME, 'חדש')).rejects.toBeInstanceOf(TenancyError);
    await rm(folders(ACME).inbox, { recursive: true, force: true });
    await createBusiness(ACME, 'חדש');
    expect(await getBusiness(ACME)).not.toBeNull();
  });
});

describe('the delete function has one caller', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('only src/tenancy/business-deletion.ts names delete_business_rows outside migrations and tests', () => {
    const files = sourceFiles(SRC).filter((f) => !f.includes(`${sep}migrations${sep}`));
    expect(files.length).toBeGreaterThan(300);
    const naming = files
      .filter((f) => readFileSync(f, 'utf8').includes('delete_business_rows'))
      .map((f) => relative(SRC, f).split(sep).join('/'));
    expect(naming).toEqual(['tenancy/business-deletion.ts']);
  });
});
