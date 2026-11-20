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
  FILE_DELETION_REFUSAL_HE,
  finishDeletion,
  passInFlight,
  recordPassEnd,
  recordPassStart,
  revokeBusinessGrants,
} from './business-deletion.js';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { withBusiness } from '../db/pool.js';
import { writeKeyState } from '../governance/master-key.js';
import { revokeGrant, writeGrant } from '../governance/oauth-grants.js';
import { revokeUrlForProvider } from '../governance/oauth-provider-revoke.js';
import { oauthProfileFor } from '../dashboard/oauth-profiles.js';
import { BusinessExistsError, createBusiness, getBusiness, TenancyError } from './businesses.js';
import { businessFolders, countFilesUnder } from './paths.js';

const ACME = 'acme';
const ACME2 = 'acme-2';
const ACME_NAME = 'Acme Shop';

const mutableConfig = config as { documentRoot: string; documentInboxRoot: string | null; documentSaveRoot: string | null };
const original = {
  documentRoot: config.documentRoot,
  documentInboxRoot: config.documentInboxRoot,
  documentSaveRoot: config.documentSaveRoot,
};
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

function folders(businessId: string): { document: string; produced: string; inbox: string; save: string } {
  const f = businessFolders(businessId);
  if (f.inbox === null || f.save === null) throw new Error('the test sets every root');
  return { document: f.document, produced: f.produced, inbox: f.inbox, save: f.save };
}

beforeAll(async () => {
  await ensureSchema();
  const docRoot = await mkdtemp(join(tmpdir(), 'bizdel-doc-'));
  const inboxRoot = await mkdtemp(join(tmpdir(), 'bizdel-inbox-'));
  // A save root of its own: the ids here are fixed, and the real test save
  // root is shared with every other suite.
  const saveRoot = await mkdtemp(join(tmpdir(), 'bizdel-save-'));
  tempRoots = [docRoot, inboxRoot, saveRoot];
  mutableConfig.documentRoot = docRoot;
  mutableConfig.documentInboxRoot = inboxRoot;
  mutableConfig.documentSaveRoot = saveRoot;
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
  mutableConfig.documentRoot = original.documentRoot;
  mutableConfig.documentInboxRoot = original.documentInboxRoot;
  mutableConfig.documentSaveRoot = original.documentSaveRoot;
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  await closePlatformPool();
  await closePool();
});

describe('businessFolders', () => {
  it('builds each folder by segment under its root, so acme and acme-2 never share one', () => {
    const a = folders(ACME);
    const b = folders(ACME2);
    expect(a.document).toBe(join(config.documentRoot, ACME));
    expect(a.produced).toBe(join(config.documentRoot, 'produced', ACME));
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
    // acme is suspended (its start would write nothing), so acme-2 runs here.
    expect(await passInFlight(ACME2)).toBe(false);
    expect(await recordPassStart(ACME2)).toBe(true);
    expect(await passInFlight(ACME2)).toBe(true);
    await recordPassEnd(ACME2);
    expect(await passInFlight(ACME2)).toBe(false);
    // Another business's pass is not this one's.
    expect(await recordPassStart(ACME2)).toBe(true);
    expect(await passInFlight(ACME)).toBe(false);
  });

  it('a start is written only for an active business: suspended, deleting and unknown write nothing', async () => {
    expect(await recordPassStart(ACME)).toBe(false);
    expect(await passInFlight(ACME)).toBe(false);
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [ACME]);
    expect(await recordPassStart(ACME)).toBe(false);
    expect(await passInFlight(ACME)).toBe(false);
    expect(await recordPassStart('nobody-here')).toBe(false);
    const { rows } = await testDb().query<{ s: Date | null }>(
      'SELECT pass_started_at AS s FROM businesses WHERE business_id = $1',
      [ACME],
    );
    expect(rows[0]?.s).toBeNull();
  });

  it('a pass started more than 30 minutes ago and never ended no longer counts', async () => {
    await testDb().query(
      `UPDATE businesses SET pass_started_at = now() - interval '31 minutes', pass_finished_at = NULL WHERE business_id = $1`,
      [ACME],
    );
    expect(await passInFlight(ACME)).toBe(false);
  });

  it('a pass started 29 minutes ago and never ended is still in flight (pins the 30-minute bound)', async () => {
    await testDb().query(
      `UPDATE businesses SET pass_started_at = now() - interval '29 minutes', pass_finished_at = NULL WHERE business_id = $1`,
      [ACME],
    );
    expect(await passInFlight(ACME)).toBe(true);
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
    // String.prototype.trim would strip these; the ASCII-only trim does not.
    await expectRefused({ typedName: `${ACME_NAME}﻿` }, 'name_mismatch');
    await expectRefused({ typedName: ` ${ACME_NAME}` }, 'name_mismatch');
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
    // The production loop's real path: <DOCUMENT_ROOT>/produced/<id>/<productionId>/...
    await putFile(join(config.documentRoot, 'produced', ACME, 'PROD-1', 'x.pdf'));
    await putFile(join(config.documentRoot, 'produced', ACME2, 'PROD-2', 'y.pdf'));
    await putFile(join(a.inbox, 'working', 'scan.pdf'));
    await putFile(join(b.document, 'DOC-2', 'original.txt'));
    await putFile(join(b.inbox, 'working', 'other.pdf'));
    await putFile(join(a.save, 'owner-copy.docx'));
  }

  async function markDeleting(id: string): Promise<void> {
    await testDb().query(`UPDATE businesses SET status = 'deleting' WHERE business_id = $1`, [id]);
  }

  async function allSeededFilesExist(): Promise<boolean> {
    const a = folders(ACME);
    for (const f of [
      join(a.document, 'DOC-1', 'original.txt'),
      join(a.document, 'produced-copy.pdf'),
      join(config.documentRoot, 'produced', ACME, 'PROD-1', 'x.pdf'),
      join(a.inbox, 'working', 'scan.pdf'),
    ]) {
      if (!(await exists(f))) return false;
    }
    return true;
  }

  it('refuses, removing nothing, for a suspended business that is not yet deleting', async () => {
    await seedFiles();
    expect(await deleteBusinessFiles(ACME)).toEqual({ ok: false, refusal: 'not_deleting' });
    expect(await allSeededFilesExist()).toBe(true);
  });

  it('refuses, removing nothing, for an active business', async () => {
    await seedFiles();
    await testDb().query(`UPDATE businesses SET status = 'active', suspended_at = NULL WHERE business_id = $1`, [ACME]);
    expect(await deleteBusinessFiles(ACME)).toEqual({ ok: false, refusal: 'not_deleting' });
    expect(await allSeededFilesExist()).toBe(true);
  });

  it('refuses, removing nothing, for an unregistered id, and for a malformed one without throwing', async () => {
    await seedFiles();
    await testDb().query('DELETE FROM businesses WHERE business_id = $1', [ACME]);
    expect(await deleteBusinessFiles(ACME)).toEqual({ ok: false, refusal: 'not_deleting' });
    expect(await allSeededFilesExist()).toBe(true);
    expect(await deleteBusinessFiles('../acme')).toEqual({ ok: false, refusal: 'not_deleting' });
    expect(await deleteBusinessFiles('')).toEqual({ ok: false, refusal: 'not_deleting' });
  });

  it('has a plain Hebrew message for its refusal', () => {
    expect(FILE_DELETION_REFUSAL_HE.not_deleting).toMatch(/[֐-׿]/);
  });

  it("removes acme's document, produced and inbox folders, and nothing of acme-2 nor acme's save folder", async () => {
    await seedFiles();
    await markDeleting(ACME);
    const result = await deleteBusinessFiles(ACME);
    expect(result).toEqual({ ok: true, removed: 4, failed: [] });
    expect(await exists(folders(ACME).document)).toBe(false);
    expect(await exists(folders(ACME).produced)).toBe(false);
    expect(await exists(folders(ACME).inbox)).toBe(false);
    // The produced root itself stays, with acme-2's folder in it.
    expect(await exists(join(config.documentRoot, 'produced', ACME2, 'PROD-2', 'y.pdf'))).toBe(true);
    expect(await exists(join(folders(ACME).save, 'owner-copy.docx'))).toBe(true);
    expect(await exists(join(folders(ACME2).document, 'DOC-2', 'original.txt'))).toBe(true);
    expect(await exists(join(folders(ACME2).inbox, 'working', 'other.pdf'))).toBe(true);
  });

  it('is a no-op on missing folders', async () => {
    await markDeleting(ACME);
    expect(await deleteBusinessFiles(ACME)).toEqual({ ok: true, removed: 0, failed: [] });
  });

  it('reports a failure by a path relative to its root, never an absolute server path', async () => {
    await seedFiles();
    await markDeleting(ACME);
    const docFolder = folders(ACME).document;
    const result = await deleteBusinessFiles(ACME, {
      rm: async (path, options) => {
        if (path === docFolder) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        await rm(path, options);
      },
    });
    if (!result.ok) throw new Error(`refused: ${result.refusal}`);
    expect(result.removed).toBe(2);
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
    await putFile(join(folders(ACME).produced, 'PROD-1', 'x.pdf'));
    expect(await finishDeletion(ACME)).toBe(false);
    await rm(folders(ACME).produced, { recursive: true, force: true });
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

  it('is refused while the document, the inbox or the produced folder holds a file', async () => {
    await testDb().query('DELETE FROM businesses WHERE business_id = $1', [ACME]);
    await putFile(join(folders(ACME).document, 'a.txt'));
    await expect(createBusiness(ACME, 'חדש')).rejects.toBeInstanceOf(TenancyError);
    await rm(folders(ACME).document, { recursive: true, force: true });
    await putFile(join(folders(ACME).inbox, 'working', 'b.txt'));
    await expect(createBusiness(ACME, 'חדש')).rejects.toBeInstanceOf(TenancyError);
    await rm(folders(ACME).inbox, { recursive: true, force: true });
    await putFile(join(config.documentRoot, 'produced', ACME, 'PROD-1', 'x.pdf'));
    await expect(createBusiness(ACME, 'חדש')).rejects.toBeInstanceOf(TenancyError);
    expect(await getBusiness(ACME)).toBeNull();
    await rm(folders(ACME).produced, { recursive: true, force: true });
    await createBusiness(ACME, 'חדש');
    expect(await getBusiness(ACME)).not.toBeNull();
  });
});

describe('createBusiness: purging residue under an unregistered id', () => {
  it('stray rows left under an id with no registry row are gone once the id is created, and the business works', async () => {
    const id = 'ghost-biz';
    // A live neighbour, seeded first so it owns every shared parent row.
    expect((await seedEveryTable(tables, ACME2)).failed).toEqual([]);
    const neighbour = await totalRows(ACME2);
    // Late writers' residue: rows under an id the registry does not hold.
    await seedEveryTable(tables, id);
    const stray = await totalRows(id);
    expect(stray['audit_log']).toBeGreaterThan(0);
    expect(await getBusiness(id)).toBeNull();

    await createBusiness(id, 'עסק חדש');
    expect(await getBusiness(id)).toEqual({ businessId: id, displayName: 'עסק חדש', status: 'active' });
    const after = await totalRows(id);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([['business_profiles', 1]]);
    expect(await totalRows(ACME2)).toEqual(neighbour);
    // And it works: a write through its own wall lands.
    await withBusiness(id, (db) =>
      db.query(`INSERT INTO business_runtime_settings (business_id, notify_to) VALUES ($1, 'new@example.com')`, [id]),
    );
    expect((await totalRows(id))['business_runtime_settings']).toBe(1);
  });

  it('on an id that is registered it still refuses, and purges nothing', async () => {
    expect((await seedEveryTable(tables, ACME2)).failed).toEqual([]);
    const before = await totalRows(ACME2);
    await expect(createBusiness(ACME2, 'מתחזה')).rejects.toBeInstanceOf(BusinessExistsError);
    expect(await totalRows(ACME2)).toEqual(before);
    expect((await getBusiness(ACME2))?.status).toBe('active');
    // A suspended one too (acme), with its rows.
    await seedEveryTable(tables, ACME);
    const acmeBefore = await sumRows(ACME);
    expect(acmeBefore).toBeGreaterThan(0);
    await expect(createBusiness(ACME, 'מתחזה')).rejects.toBeInstanceOf(BusinessExistsError);
    expect(await sumRows(ACME)).toBe(acmeBefore);
  });
});

describe('the whole chain, then the same id again', () => {
  it('rows, files, registry row, then createBusiness: the new business starts empty', async () => {
    expect((await seedEveryTable(tables, ACME)).failed).toEqual([]);
    const f = folders(ACME);
    await putFile(join(f.document, 'DOC-1', 'original.txt'));
    await putFile(join(f.inbox, 'working', 'scan.pdf'));

    const rows = await deleteBusinessRows({ businessId: ACME, staffId: headId, typedName: ACME_NAME });
    expect(rows.ok).toBe(true);
    expect(await deleteBusinessFiles(ACME)).toEqual({ ok: true, removed: 2, failed: [] });
    expect(await finishDeletion(ACME)).toBe(true);

    await createBusiness(ACME, 'עסק חדש');
    expect(await getBusiness(ACME)).toEqual({ businessId: ACME, displayName: 'עסק חדש', status: 'active' });
    // createBusiness writes only its profile row.
    const after = await totalRows(ACME);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([['business_profiles', 1]]);
    expect(await countFilesUnder(f.document)).toBe(0);
    expect(await countFilesUnder(f.inbox)).toBe(0);
    expect(await countFilesUnder(f.save)).toBe(0);
  });
});

describe('revokeBusinessGrants — at the provider, before the rows go', () => {
  const KEY = randomBytes(32);
  const TOKENS = ['refresh-token-AAA-secret', 'refresh-token-BBB-secret', 'refresh-token-MS-secret'];

  interface Call {
    url: string;
    init: RequestInit | undefined;
  }

  function stubFetch(calls: Call[], fail: (n: number) => boolean = () => false): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (fail(calls.length)) return new Response('nope', { status: 400 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
  }

  async function grant(system: string, provider: string, refreshToken: string): Promise<void> {
    await withBusiness(ACME, (bdb) =>
      writeGrant(
        bdb,
        { system, provider, credentialRef: system.toUpperCase().replace(/-/g, '_'), account: 'owner@example.com', scopes: ['s'], refreshToken, grantedBy: 'owner' },
        KEY,
      ),
    );
  }

  beforeEach(async () => {
    await writeKeyState(KEY, 'KEY-test', testDb());
  });

  it('POSTs each live Google grant once, the token only in the body, and skips a revoked grant', async () => {
    await grant('mailbox', 'google', TOKENS[0]!);
    await grant('calendar', 'google', TOKENS[1]!);
    await grant('office-calendar', 'google', 'refresh-token-REVOKED');
    await withBusiness(ACME, (bdb) => revokeGrant(bdb, 'office-calendar', 'owner'));
    const calls: Call[] = [];
    const result = await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: stubFetch(calls) });
    expect(result).toEqual({ ok: true, attempted: 2, failed: 0, grantsUnreadable: false });
    expect(calls).toHaveLength(2);
    const bodies = calls.map((c) => String(c.init?.body));
    for (const [i, c] of calls.entries()) {
      expect(c.url).toBe('https://oauth2.googleapis.com/revoke');
      expect(c.init?.method).toBe('POST');
      const headers = JSON.stringify(c.init?.headers ?? {});
      for (const t of TOKENS) {
        expect(c.url).not.toContain(t);
        expect(headers).not.toContain(t);
      }
      expect(bodies[i]).toMatch(/^token=refresh-token-/);
    }
    expect(bodies.some((b) => b.includes(TOKENS[0]!))).toBe(true);
    expect(bodies.some((b) => b.includes(TOKENS[1]!))).toBe(true);
    expect(bodies.some((b) => b.includes('REVOKED'))).toBe(false);
  });

  it('sends no POST for a Microsoft grant, and does not count it as attempted', async () => {
    await grant('mailbox', 'microsoft', TOKENS[2]!);
    const calls: Call[] = [];
    const result = await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: stubFetch(calls) });
    expect(result).toEqual({ ok: true, attempted: 0, failed: 0, grantsUnreadable: false });
    expect(calls).toHaveLength(0);
  });

  it('a failing POST, a throwing fetch, and an unopenable grant count as failed; nothing throws', async () => {
    await grant('mailbox', 'google', TOKENS[0]!);
    await grant('calendar', 'google', TOKENS[1]!);
    const calls: Call[] = [];
    expect(
      await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: stubFetch(calls, (n) => n === 2) }),
    ).toEqual({ ok: true, attempted: 2, failed: 1, grantsUnreadable: false });

    const throwing = (async () => {
      throw new Error(`network down ${TOKENS[0]}`);
    }) as typeof fetch;
    expect(await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: throwing })).toEqual({
      ok: true,
      attempted: 2,
      failed: 2,
      grantsUnreadable: false,
    });

    // A wrong key: each grant fails to decrypt — attempted and failed, no POST.
    const none: Call[] = [];
    expect(
      await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: randomBytes(32) }, { fetchImpl: stubFetch(none) }),
    ).toEqual({ ok: true, attempted: 2, failed: 2, grantsUnreadable: false });
    expect(none).toHaveLength(0);
  });

  it('stops waiting at the deadline and counts the hung POST as failed', async () => {
    await grant('mailbox', 'google', TOKENS[0]!);
    let aborted = false;
    const hanging = ((_u: string, init?: RequestInit) =>
      new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
      })) as unknown as typeof fetch;
    const result = await revokeBusinessGrants(
      { businessId: ACME, staffId: headId, key: KEY },
      { fetchImpl: hanging, deadlineMs: 50 },
    );
    expect(result).toEqual({ ok: true, attempted: 1, failed: 1, grantsUnreadable: false });
    expect(aborted).toBe(true);
  });

  it('never writes a token to the console', async () => {
    await grant('mailbox', 'google', TOKENS[0]!);
    await grant('calendar', 'google', TOKENS[1]!);
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const throwing = (async () => {
        throw new Error(`boom ${TOKENS[0]} ${TOKENS[1]}`);
      }) as typeof fetch;
      await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: throwing });
      await revokeBusinessGrants({ businessId: ACME, staffId: headId, key: KEY }, { fetchImpl: stubFetch([], () => true) });
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      for (const t of TOKENS) expect(logged).not.toContain(t);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('refuses an active business, a staff member who is not a head admin, an unknown id and a malformed one — never calling the provider', async () => {
    await grant('mailbox', 'google', TOKENS[0]!);
    await withBusiness(ACME2, (bdb) =>
      writeGrant(
        bdb,
        { system: 'mailbox', provider: 'google', credentialRef: 'MAILBOX', account: 'o@example.com', scopes: ['s'], refreshToken: TOKENS[1]!, grantedBy: 'owner' },
        KEY,
      ),
    );
    const plain = `ST-${ulid()}`;
    await testDb().query(`INSERT INTO platform_staff (staff_id, login, display_name) VALUES ($1, $2, 'טכנאי')`, [
      plain,
      `tech-${ulid().toLowerCase()}@example.com`,
    ]);
    const calls: Call[] = [];
    const fetchImpl = stubFetch(calls);
    expect(await revokeBusinessGrants({ businessId: ACME2, staffId: headId, key: KEY }, { fetchImpl })).toEqual({
      ok: false,
      refusal: 'not_suspended',
    });
    expect(await revokeBusinessGrants({ businessId: ACME, staffId: plain, key: KEY }, { fetchImpl })).toEqual({
      ok: false,
      refusal: 'not_head',
    });
    expect(await revokeBusinessGrants({ businessId: 'nobody-here', staffId: headId, key: KEY }, { fetchImpl })).toEqual({
      ok: false,
      refusal: 'unknown_business',
    });
    expect(await revokeBusinessGrants({ businessId: '../x', staffId: headId, key: KEY }, { fetchImpl })).toEqual({
      ok: false,
      refusal: 'unknown_business',
    });
    expect(calls).toHaveLength(0);
    for (const r of ['not_suspended', 'not_head', 'unknown_business'] as const) expect(DELETION_REFUSAL_HE[r]).toBeTruthy();
  });

  it('the provider revoke URL agrees with every OAuth profile', () => {
    for (const provider of ['google', 'microsoft'] as const) {
      for (const connection of [
        { system: 'mailbox', serves: ['mail.send'] },
        { system: 'calendar', serves: ['calendar.read', 'calendar.write'] },
      ]) {
        const profile = oauthProfileFor(connection as never, provider);
        expect(profile).not.toBeNull();
        expect(revokeUrlForProvider(profile!.provider)).toBe(profile!.revokeUrl);
      }
    }
    expect(revokeUrlForProvider('something-else')).toBeNull();
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

  it('only business-deletion.ts and createBusiness (businesses.ts) name delete_business_rows outside migrations and tests', () => {
    const files = sourceFiles(SRC).filter((f) => !f.includes(`${sep}migrations${sep}`));
    expect(files.length).toBeGreaterThan(300);
    const naming = files
      .filter((f) => readFileSync(f, 'utf8').includes('delete_business_rows'))
      .map((f) => relative(SRC, f).split(sep).join('/'));
    expect(naming.sort()).toEqual(['tenancy/business-deletion.ts', 'tenancy/businesses.ts']);
  });
});
