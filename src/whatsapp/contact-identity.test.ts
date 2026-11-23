import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../db/pool.js';
import { resetDatabase } from '../test/db.js';
import { TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { activeCharterVersion, installCharter } from '../charter/store.js';
import { addColleague } from '../business/colleagues.js';
import { addManagedContact } from '../business/settings-contacts.js';
import { PersonEntry } from '../business/setup-package.js';
import { writeMemory } from '../memory/store.js';
import { createJob } from '../orchestrator/jobs.js';
import { resolveSender } from './contact-identity.js';

const PRINCIPAL = '+972541234567';
const base = buildCharter({ version: 'v-ident-1' });
const charter = {
  ...base,
  people: base.people.map((p, i) => (i === 0 ? { ...p, isPrincipal: true, channels: { whatsapp: PRINCIPAL } } : p)),
};

beforeEach(async () => {
  await resetDatabase();
  await withBusiness(TEST_BUSINESS, (db) => installCharter(db, buildCharter({ version: 'v-ident-1' })));
});

afterAll(async () => {
  await closePool();
});

const entry = (phone: string, extra: Record<string, unknown> = {}) =>
  PersonEntry.parse({ name: 'דנה', role: 'לקוחה', phone, ...extra });

describe('resolveSender', () => {
  it('resolves the principal', async () => {
    const r = await withBusiness(TEST_BUSINESS, (db) => resolveSender(db, charter, PRINCIPAL));
    expect(r).toEqual({ kind: 'principal' });
  });

  it('resolves a managed contact by canonical number', async () => {
    const r = await withBusiness(TEST_BUSINESS, async (db) => {
      await addManagedContact(db, entry('+972501110001', { kind: 'client', email: 'dana@example.com' }));
      return resolveSender(db, charter, '+972 50-111-0001');
    });
    expect(r.kind).toBe('contact');
    if (r.kind !== 'contact') return;
    expect(r.key).toBe('972501110001');
    expect(r.contact).toMatchObject({ name: 'דנה', kind: 'client', email: 'dana@example.com' });
  });

  it('a colleague is colleague even with a managed-contact row', async () => {
    const r = await withBusiness(TEST_BUSINESS, async (db) => {
      await addColleague(db, entry('+972501110002'));
      await addManagedContact(db, entry('+972501110002'));
      return resolveSender(db, charter, '+972501110002');
    });
    expect(r).toEqual({ kind: 'colleague', key: '972501110002' });
  });

  it('an entity learned from a document with the same phone is unknown', async () => {
    const r = await withBusiness(TEST_BUSINESS, async (db) => {
      const version = await activeCharterVersion(db);
      const job = await createJob(db, { charterVersion: version ?? '', provenance: 'unknown_external', title: 'seed' });
      await writeMemory(db, {
        jobId: job.jobId,
        kind: 'entity',
        subjectKey: '+972501110003',
        body: { name: 'זר', role: 'ספק', phone: '+972501110003' },
        sourceRef: null,
      });
      return resolveSender(db, charter, '+972501110003');
    });
    expect(r).toEqual({ kind: 'unknown', key: '972501110003' });
  });

  it('malformed sender (no +, @c.us, 22-digit group id) is unknown with key null', async () => {
    await withBusiness(TEST_BUSINESS, async (db) => {
      for (const bad of ['972501110001', '972501110001@c.us', '120363012345678901234@g.us', '']) {
        expect(await resolveSender(db, charter, bad)).toEqual({ kind: 'unknown', key: null });
      }
    });
  });
});
