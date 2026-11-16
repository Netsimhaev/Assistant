import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, type BusinessDb } from '../db/pool.js';
import { resetDatabase, testDb, TEST_BUSINESS } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { installCharter, loadActiveCharter } from '../charter/store.js';
import { freezeDraft, loadDraft, replaceDraft } from '../charter/interview/draft-store.js';
import { shownHashFor, signAndInstallInterview } from '../charter/interview/install.js';
import { completeAnswers } from '../charter/interview/test-answers.js';
import type { InterviewAnswers } from '../charter/interview/answers.js';
import { isPrincipalSender } from '../governance/principal-number.js';
import { setupDataForPanel } from '../tenancy/panel-reads.js';
import { listColleagues } from './colleagues.js';
import { CONFIRM_PEOPLE_JOB_TITLE, SetupPeopleInputError, confirmSetupPeople, unconfirmedSetupPeople } from './confirm-people.js';
import { loadSetupPackage, saveSetupPackage, type SetupPackage } from './setup-package.js';

const TECH = 'tech-1';
const OWNER = 'owner';
const BOSS = '+972541234567';
const NO_PREFLIGHT = async (): Promise<string | null> => {
  throw new Error('mailbox preflight reached');
};

const PACKAGE: SetupPackage = {
  bossWhatsapp: BOSS,
  contacts: [
    { name: 'רונית כהן', role: 'לקוחה', phone: '+972501110001' },
    { name: 'משה לוי', role: 'ספק', phone: '+972501110002' },
  ],
  colleagues: [{ name: 'יוסי', role: 'מנהל עבודה', phone: '+972501110003' }],
};

const run = <T>(fn: (db: BusinessDb) => Promise<T>): Promise<T> => withBusiness(TEST_BUSINESS, fn);

async function seedPackage(pkg: SetupPackage = PACKAGE): Promise<void> {
  await run((db) => saveSetupPackage(db, pkg, TECH));
}

/** A complete interview draft with no WhatsApp number of its own (the owner kept the package's). */
function answersWithBoss(): InterviewAnswers {
  const answers = completeAnswers();
  answers.principal.whatsapp = BOSS;
  return answers;
}

async function startDraft(answers: InterviewAnswers = answersWithBoss()): Promise<void> {
  await run((db) => replaceDraft(db, answers, null));
}

async function freezeAndSign(): Promise<ReturnType<typeof signAndInstallInterview>> {
  await run((db) => freezeDraft(db, new Date('2026-11-17T10:00:00.000Z')));
  const draft = await run((db) => loadDraft(db));
  if (draft === null) throw new Error('draft missing');
  const shownHash = shownHashFor(draft, TEST_BUSINESS, null);
  return run((db) => signAndInstallInterview(db, { username: OWNER, shownHash, mailboxPreflight: NO_PREFLIGHT }));
}

async function liveEntities(): Promise<Array<{ subject_key: string; body: Record<string, unknown>; provenance: string; source_ref: string | null }>> {
  const { rows } = await testDb().query<{
    subject_key: string;
    body: Record<string, unknown>;
    provenance: string;
    source_ref: string | null;
  }>(
    `SELECT subject_key, body, provenance, source_ref FROM memories
      WHERE business_id = $1 AND kind = 'entity' AND retired_at IS NULL ORDER BY subject_key`,
    [TEST_BUSINESS],
  );
  return rows;
}

describe('unconfirmedSetupPeople', () => {
  it('counts package people the snapshot does not hold, per list', () => {
    expect(unconfirmedSetupPeople(null, undefined)).toBe(0);
    expect(unconfirmedSetupPeople(PACKAGE, undefined)).toBe(3);
    const snapshot = {
      contacts: PACKAGE.contacts.map((c) => ({ ...c, known: false })),
      colleagues: [...PACKAGE.colleagues],
    };
    expect(unconfirmedSetupPeople(PACKAGE, snapshot)).toBe(0);
    expect(unconfirmedSetupPeople({ ...PACKAGE, contacts: [...PACKAGE.contacts, { name: 'x', role: 'y', phone: '+972501110009' }] }, snapshot)).toBe(1);
    // A contact's phone confirmed as a colleague is still an unconfirmed contact.
    expect(unconfirmedSetupPeople(PACKAGE, { contacts: [], colleagues: [...PACKAGE.colleagues] })).toBe(2);
  });
});

describe('confirmSetupPeople (step 8)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closePool();
  });

  it('records a snapshot and the known entries in the draft, and changes nothing else before signature', async () => {
    await seedPackage();
    await startDraft();

    const result = await run((db) => confirmSetupPeople(db, { knownIndices: [0] }));
    expect(result).toEqual({ contacts: 2, colleagues: 1, known: 1 });

    const draft = await run((db) => loadDraft(db));
    expect(draft?.answers.setupPeople).toEqual({
      contacts: [
        { name: 'רונית כהן', role: 'לקוחה', phone: '+972501110001', known: true },
        { name: 'משה לוי', role: 'ספק', phone: '+972501110002', known: false },
      ],
      colleagues: [{ name: 'יוסי', role: 'מנהל עבודה', phone: '+972501110003' }],
    });
    expect(draft?.answers.counterparties?.known).toContainEqual({ label: 'רונית כהן — לקוחה', phone: '+972501110001' });
    expect(draft?.answers.counterparties?.known.some((k) => k.phone === '+972501110002')).toBe(false);

    // Pending until signature: no memory, no colleague, the package as it was.
    expect(await liveEntities()).toEqual([]);
    expect(await run((db) => listColleagues(db))).toEqual([]);
    expect(await run((db) => loadSetupPackage(db))).toEqual(PACKAGE);
    // The panel still shows the technician's data: nothing is locked yet.
    const panel = await setupDataForPanel(TEST_BUSINESS);
    expect(panel).not.toBe('locked');
    if (panel === 'locked') return;
    expect(panel.contacts).toHaveLength(2);
    expect(panel.colleagues).toHaveLength(1);
  });

  it('works with no draft yet, creating one', async () => {
    await seedPackage();
    expect(await run((db) => confirmSetupPeople(db, { knownIndices: [] }))).toEqual({ contacts: 2, colleagues: 1, known: 0 });
    const draft = await run((db) => loadDraft(db));
    expect(draft?.answers.setupPeople?.contacts).toHaveLength(2);
    // No known contact → the counterparties section is not touched.
    expect(draft?.answers.counterparties).toBeUndefined();
  });

  it('returns zeros and writes nothing on an empty package', async () => {
    expect(await run((db) => confirmSetupPeople(db, { knownIndices: [] }))).toEqual({ contacts: 0, colleagues: 0, known: 0 });
    expect(await run((db) => loadDraft(db))).toBeNull();
  });

  it.each([[[2]], [[-1]], [[0.5]], [[Number.NaN]]])('refuses index %j and writes nothing', async (indices) => {
    await seedPackage();
    await expect(run((db) => confirmSetupPeople(db, { knownIndices: indices }))).rejects.toBeInstanceOf(SetupPeopleInputError);
    expect(await run((db) => loadDraft(db))).toBeNull();
  });

  it('dedupes indices, and a second confirm does not append a known entry twice', async () => {
    await seedPackage();
    await startDraft();
    await run((db) => confirmSetupPeople(db, { knownIndices: [0, 0] }));
    await run((db) => confirmSetupPeople(db, { knownIndices: [0] }));
    const known = (await run((db) => loadDraft(db)))?.answers.counterparties?.known ?? [];
    expect(known.filter((k) => k.phone === '+972501110001')).toHaveLength(1);
  });

  it('two confirms at once append the known entry once', async () => {
    await seedPackage();
    await startDraft();
    await Promise.all([
      run((db) => confirmSetupPeople(db, { knownIndices: [0] })),
      run((db) => confirmSetupPeople(db, { knownIndices: [0] })),
    ]);
    const known = (await run((db) => loadDraft(db)))?.answers.counterparties?.known ?? [];
    expect(known.filter((k) => k.phone === '+972501110001')).toHaveLength(1);
  });

  it('refuses nothing and writes nothing once the business has no package people', async () => {
    await seedPackage({ bossWhatsapp: BOSS, contacts: [], colleagues: [] });
    expect(await run((db) => confirmSetupPeople(db, { knownIndices: [] }))).toEqual({ contacts: 0, colleagues: 0, known: 0 });
  });
});

describe('signing applies the confirmed setup people', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('writes the memories, the colleague and the known counterparty, clears the package, and the boss number is the principal', async () => {
    await seedPackage();
    await startDraft();
    await run((db) => confirmSetupPeople(db, { knownIndices: [0] }));

    const outcome = await freezeAndSign();
    expect(outcome.outcome).toBe('installed');

    const entities = await liveEntities();
    expect(entities).toEqual([
      { subject_key: '+972501110001', body: { name: 'רונית כהן', role: 'לקוחה', phone: '+972501110001' }, provenance: 'boss', source_ref: 'setup_package' },
      { subject_key: '+972501110002', body: { name: 'משה לוי', role: 'ספק', phone: '+972501110002' }, provenance: 'boss', source_ref: 'setup_package' },
    ]);
    const colleagues = await run((db) => listColleagues(db));
    expect(colleagues.map((c) => [c.name, c.role, c.phone])).toEqual([['יוסי', 'מנהל עבודה', '+972501110003']]);

    const active = await run((db) => loadActiveCharter(db));
    if (active === null) throw new Error('no charter');
    expect(JSON.stringify(active.charter.counterparties)).toContain('+972501110001');
    // The unchecked contact is remembered, but not a known counterparty.
    expect(JSON.stringify(active.charter.counterparties)).not.toContain('+972501110002');

    expect(isPrincipalSender(active.charter, BOSS)).toBe(true);
    expect(await run((db) => loadSetupPackage(db))).toBeNull();

    // The job that wrote them is the owner's, and closed.
    const { rows } = await testDb().query<{ phase: string; provenance: string }>(
      'SELECT phase, provenance FROM jobs WHERE business_id = $1 AND title = $2',
      [TEST_BUSINESS, CONFIRM_PEOPLE_JOB_TITLE],
    );
    expect(rows).toEqual([{ phase: 'closed', provenance: 'boss' }]);
  });

  it('a double sign adds nothing twice', async () => {
    await seedPackage();
    await startDraft();
    await run((db) => confirmSetupPeople(db, { knownIndices: [] }));
    await run((db) => freezeDraft(db, new Date('2026-11-17T10:00:00.000Z')));
    const draft = await run((db) => loadDraft(db));
    if (draft === null) throw new Error('draft missing');
    const shownHash = shownHashFor(draft, TEST_BUSINESS, null);
    const sign = () => run((db) => signAndInstallInterview(db, { username: OWNER, shownHash, mailboxPreflight: NO_PREFLIGHT }));
    const outcomes = await Promise.all([sign(), sign()]);
    expect(outcomes.filter((o) => o.outcome === 'installed')).toHaveLength(1);
    expect(await liveEntities()).toHaveLength(2);
    expect(await run((db) => listColleagues(db))).toHaveLength(1);
  });

  it('clears package people the technician added after the owner confirmed — only the snapshot takes effect', async () => {
    await seedPackage();
    await startDraft();
    await run((db) => confirmSetupPeople(db, { knownIndices: [] }));
    const later = { name: 'נוסף אחר כך', role: 'לקוח', phone: '+972501110009' };
    await seedPackage({ ...PACKAGE, contacts: [...PACKAGE.contacts, later] });

    expect((await freezeAndSign()).outcome).toBe('installed');
    // Only the snapshot took effect; the leftover is cleared with the rest, not stranded.
    expect(await liveEntities()).toHaveLength(2);
    expect(JSON.stringify(await liveEntities())).not.toContain('+972501110009');
    expect(await run((db) => loadSetupPackage(db))).toBeNull();
  });

  it('a sign with no snapshot adds nobody and clears the whole package', async () => {
    await seedPackage();
    await startDraft();
    expect((await freezeAndSign()).outcome).toBe('installed');
    expect(await liveEntities()).toEqual([]);
    expect(await run((db) => listColleagues(db))).toEqual([]);
    expect(await run((db) => loadSetupPackage(db))).toBeNull();
  });

  it('the summary hash covers the snapshot', async () => {
    await seedPackage();
    await startDraft();
    await run((db) => freezeDraft(db, new Date('2026-11-17T10:00:00.000Z')));
    const before = await run((db) => loadDraft(db));
    if (before === null) throw new Error('draft missing');
    const hashWithout = shownHashFor(before, TEST_BUSINESS, null);
    await run((db) => confirmSetupPeople(db, { knownIndices: [] }));
    await run((db) => freezeDraft(db, new Date('2026-11-17T10:00:00.000Z')));
    const after = await run((db) => loadDraft(db));
    if (after === null) throw new Error('draft missing');
    // The charter is unchanged (no known contact), yet the hash moved.
    expect(shownHashFor(after, TEST_BUSINESS, null)).not.toBe(hashWithout);
  });

  it('confirming with an active charter lands in the edit draft', async () => {
    await run((db) => installCharter(db, buildCharter()));
    await testDb().query(
      `INSERT INTO setup_packages (business_id, boss_whatsapp, contacts, colleagues, updated_by)
       VALUES ($1, NULL, $2::jsonb, '[]'::jsonb, 'tech')`,
      [TEST_BUSINESS, JSON.stringify([PACKAGE.contacts[0]])],
    );
    await run((db) => replaceDraft(db, {}, null));
    expect(await run((db) => confirmSetupPeople(db, { knownIndices: [] }))).toEqual({ contacts: 1, colleagues: 0, known: 0 });
  });
});
