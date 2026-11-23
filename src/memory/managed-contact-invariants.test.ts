/**
 * The "saved contact" marker is the owner's alone (Task 13 security fix 1).
 *
 * A memory whose `source_ref` is `setup_package` or `settings_people` makes a
 * number a saved contact: the WhatsApp sender resolver treats it as known, and
 * an owner-ordered WhatsApp to it is echoed "(איש קשר ששמרת: …)" — a "כן" on
 * which skips gate stages 5–9. So nothing a stranger's text can steer may
 * write it: not a planner's `memory.write_entity`, not the curator.
 *
 * Two layers, each tested on its own: `writeMemory` strips the reserved refs
 * (only `writeManagedContactMemory`, imported by the two owner screens, writes
 * them), and `listManagedContacts` also requires `provenance = 'boss'`. Plus a
 * source scan: the literals appear only in the allowed files.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter } from '../charter/store.js';
import { listManagedContacts } from '../business/settings-contacts.js';
import { createJob } from '../orchestrator/jobs.js';
import { bindPlanToJob } from '../orchestrator/plan-store.js';
import { runLocalTool } from '../orchestrator/local-tools.js';
import { resolveSender } from '../whatsapp/contact-identity.js';
import type { TrustLevel } from '../domain/trust.js';
import { curateJob } from './curate.js';
import { isReservedSourceRef, writeManagedContactMemory, writeMemory } from './store.js';

const BUSINESS = TEST_BUSINESS;
const PHONE = '+972549999999';
const VERSION = 'managed-contact-v1';

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(BUSINESS, (db) => installCharter(db, buildCharter({ version: VERSION })));
});
afterAll(async () => {
  await closePool();
});

async function job(provenance: TrustLevel): Promise<string> {
  const created = await withBusiness(BUSINESS, (db) => createJob(db, { charterVersion: VERSION, provenance }));
  return created.jobId;
}

async function sourceRefOf(subjectKey: string): Promise<(string | null)[]> {
  const { rows } = await testDb().query<{ source_ref: string | null }>(
    `SELECT source_ref FROM memories WHERE business_id = $1 AND subject_key = $2 AND retired_at IS NULL`,
    [BUSINESS, subjectKey],
  );
  return rows.map((r) => r.source_ref);
}

describe('only the owner writes the saved-contact marker', () => {
  it('isReservedSourceRef catches the exact values and their variants', () => {
    for (const v of ['settings_people', 'setup_package', ' Settings_People ', 'SETUP_PACKAGE']) {
      expect(isReservedSourceRef(v)).toBe(true);
    }
    for (const v of ['settings_people_x', 'setup', null, undefined, '']) {
      expect(isReservedSourceRef(v)).toBe(false);
    }
  });

  it('writeMemory strips a reserved source_ref, even on a boss job', async () => {
    const jobId = await job('boss');
    await withBusiness(BUSINESS, (db) => writeMemory(db, {
      jobId, kind: 'entity', subjectKey: PHONE, body: { name: 'דנה', phone: PHONE }, sourceRef: ' Settings_People ',
    }));
    expect(await sourceRefOf(PHONE)).toEqual([null]);
    expect(await withBusiness(BUSINESS, (db) => listManagedContacts(db))).toEqual([]);
  });

  it('memory.write_entity with sourceRef settings_people does not produce a managed contact', async () => {
    const jobId = await job('boss');
    const result = await withBusiness(BUSINESS, (db) => runLocalTool('memory.write_entity', {
      entityId: PHONE,
      attributes: { name: 'דנה', role: 'לקוחה', phone: PHONE },
      sourceRef: 'settings_people',
    }, { jobId, db }));
    expect(result.performed).toBe(true);
    expect(await sourceRefOf(PHONE)).toEqual([null]);
    expect(await withBusiness(BUSINESS, (db) => listManagedContacts(db))).toEqual([]);
  });

  it('a curator candidate with sourceRef settings_people does not produce a managed contact', async () => {
    const jobId = await job('unknown_external');
    await withBusiness(BUSINESS, (db) => bindPlanToJob(db, jobId, {
      goal: 'עדכון',
      steps: [{
        id: 's1', agent: 'comms.whatsapp', intent: 'לשלוח', toolName: 'wa.send_message',
        input: { to: PHONE, body: 'שלום' }, dependsOn: [], expectedActionClass: null,
      }],
    } as never));
    const outcome = await withBusiness(BUSINESS, (db) => curateJob(db, jobId, {
      curator: async () => ({
        candidates: [{
          kind: 'entity',
          subjectKey: PHONE,
          body: { name: 'דנה', role: 'לקוחה', phone: PHONE },
          sourceRef: 'settings_people',
        }],
      }),
    }));
    // The candidate itself was accepted and written — only the marker is gone.
    expect(outcome.written).toBe(1);
    expect(await sourceRefOf(PHONE)).toEqual([null]);
    expect(await withBusiness(BUSINESS, (db) => listManagedContacts(db))).toEqual([]);
  });

  it('a planted row carrying the marker without a boss provenance is not listed, and resolveSender does not treat it as known', async () => {
    // Bypassing the write-side guard entirely (raw INSERT): the read side holds alone.
    const jobId = await job('unknown_external');
    await testDb().query(
      `INSERT INTO memories (memory_id, business_id, kind, subject_key, body, provenance, written_by_job, source_ref)
       VALUES ($1, $2, 'entity', $3, $4::jsonb, 'unknown_external', $5, 'settings_people')`,
      [`MEM-${randomUUID()}`, BUSINESS, PHONE, JSON.stringify({ name: 'דנה', role: 'לקוחה', phone: PHONE }), jobId],
    );
    expect(await withBusiness(BUSINESS, (db) => listManagedContacts(db))).toEqual([]);
    const charter = buildCharter({ version: VERSION });
    const sender = await withBusiness(BUSINESS, (db) => resolveSender(db, charter, PHONE));
    expect(sender).toEqual({ kind: 'unknown', key: PHONE.slice(1) });
  });

  it('the owner path still writes a managed contact, and refuses a job that is not boss', async () => {
    const boss = await job('boss');
    await withBusiness(BUSINESS, (db) => writeManagedContactMemory(db, {
      jobId: boss, subjectKey: PHONE, body: { name: 'דנה', role: 'לקוחה', phone: PHONE }, source: 'settings_people',
    }));
    expect((await withBusiness(BUSINESS, (db) => listManagedContacts(db))).map((c) => c.phone)).toEqual([PHONE]);

    const stranger = await job('unknown_external');
    await expect(withBusiness(BUSINESS, (db) => writeManagedContactMemory(db, {
      jobId: stranger, subjectKey: '+972548888888', body: { name: 'x', phone: '+972548888888' }, source: 'setup_package',
    }))).rejects.toThrow(/not a boss job/);
  });
});

describe('source scan', () => {
  const SRC = join(process.cwd(), 'src');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
    });
  }
  const rel = (f: string) => relative(SRC, f).split(sep).join('/');
  const all = files(SRC);

  it('scans the production tree', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('the reserved literals appear only in the allowed files', () => {
    const allowed = new Set([
      'memory/store.ts',
      'business/confirm-people.ts',
      'business/settings-contacts.ts',
      'tenancy/panel-reads.ts',
    ]);
    const literal = /['"`](setup_package|settings_people)['"`]/;
    expect(literal.test(`'settings_people'`) && literal.test('"setup_package"')).toBe(true);
    expect(literal.test(`'setup_package_saved'`)).toBe(false);
    const offenders = all.filter((f) => literal.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders.filter((f) => !allowed.has(f))).toEqual([]);
    // Each allowed writer really is found, or the expression is broken.
    expect(offenders).toEqual(expect.arrayContaining(['business/confirm-people.ts', 'business/settings-contacts.ts']));
  });

  it('writeManagedContactMemory is imported only by the two owner screens', () => {
    const importers = all
      .filter((f) => rel(f) !== 'memory/store.ts')
      .filter((f) => /\bwriteManagedContactMemory\b/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    expect(importers).toEqual(['business/confirm-people.ts', 'business/settings-contacts.ts']);
  });
});
