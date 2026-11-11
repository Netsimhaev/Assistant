import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness, type BusinessDb } from '../../db/pool.js';
import { loadAutonomyMode } from '../../governance/autonomy-mode.js';
import { resetDatabase, testDb } from '../../test/db.js';
import { buildCharter } from '../../test/fixtures.js';
import { activeCharterVersion, installCharter, loadCharterVersion } from '../store.js';
import { InterviewAnswers } from './answers.js';
import { freezeDraft, loadDraft, replaceDraft, saveSection } from './draft-store.js';
import { previousForDraft, shownHashFor, signAndInstallInterview } from './install.js';
import { completeAnswers } from './test-answers.js';

const A = 'business-a';
const OWNER = 'dana';
/** No test here adds a mailbox unless it says so; a preflight that is reached fails the test. */
const NO_PREFLIGHT = async (): Promise<string | null> => {
  throw new Error('mailbox preflight reached');
};

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? '0');
}

const charterRows = (): Promise<number> =>
  count('SELECT count(*)::text AS n FROM charter_versions WHERE business_id = $1', [A]);
const changeRows = (): Promise<number> =>
  count(`SELECT count(*)::text AS n FROM audit_log WHERE business_id = $1 AND kind = 'charter_change'`, [A]);
const draftRows = (): Promise<number> =>
  count('SELECT count(*)::text AS n FROM charter_interview_drafts WHERE business_id = $1', [A]);

/** A complete draft, frozen, and the hash its summary would show. */
async function frozenDraft(
  answers: InterviewAnswers = completeAnswers(),
  base: string | null = null,
): Promise<string> {
  await withBusiness(A, (bdb) => replaceDraft(bdb, answers, base));
  await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00.000Z')));
  const draft = await withBusiness(A, (bdb) => loadDraft(bdb));
  if (draft === null) throw new Error('draft missing');
  const previous = base === null ? null : await withBusiness(A, (bdb) => loadCharterVersion(bdb, base));
  return shownHashFor(draft, A, previous);
}

describe('signAndInstallInterview', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('first install activates the charter, writes one charter_change row, deletes the draft', async () => {
    const shownHash = await frozenDraft();

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome.outcome).toBe('installed');
    if (outcome.outcome !== 'installed') return;
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBe(outcome.charterVersion);
    const installed = await withBusiness(A, (bdb) => loadCharterVersion(bdb, outcome.charterVersion));
    expect(installed?.signature.signedByPersonId).toBe(OWNER);
    expect(installed?.signature.method).toBe('dashboard_click');
    expect(await changeRows()).toBe(1);
    expect(await draftRows()).toBe(0);

    // The audit reason names who signed, never what was answered.
    const { rows } = await testDb().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'charter_change'`,
      [A],
    );
    const reason = rows[0]?.reason ?? '';
    expect(reason).toBe(`charter signed through the setup interview by ${OWNER}`);
    const answers = completeAnswers();
    expect(reason).not.toContain(answers.principal.displayName);
    expect(reason).not.toContain(answers.business.tradeName);
  });

  it('applies the chosen mode only after install', async () => {
    const answers = completeAnswers();
    answers.autonomy = { mode: 'learn' };
    const shownHash = await frozenDraft(answers);
    expect(await withBusiness(A, (bdb) => loadAutonomyMode(bdb))).toBe('off');

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome).toMatchObject({ outcome: 'installed', modeApplied: true });
    expect(await withBusiness(A, (bdb) => loadAutonomyMode(bdb))).toBe('learn');
  });

  it('refuses a sign whose shown hash is stale', async () => {
    const shownHash = await frozenDraft();
    const draft = await withBusiness(A, (bdb) => loadDraft(bdb));
    // An edit unfreezes; the review is reached again and freezes a new moment.
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', { ...completeAnswers().business, employees: 7 }));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T11:00:00.000Z')));
    expect((await withBusiness(A, (bdb) => loadDraft(bdb)))?.frozenAt?.getTime()).not.toBe(draft?.frozenAt?.getTime());

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome).toEqual({ outcome: 'hash_mismatch' });
    expect(await charterRows()).toBe(0);
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBeNull();
    expect(await draftRows()).toBe(1);
  });

  it('refuses an unfrozen draft and a missing or partial one', async () => {
    expect(await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash: 'x' }))).toEqual({
      outcome: 'incomplete',
    });

    await withBusiness(A, (bdb) => saveSection(bdb, 'business', completeAnswers().business));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00.000Z')));
    expect(await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash: 'x' }))).toEqual({
      outcome: 'incomplete',
    });

    await withBusiness(A, (bdb) => replaceDraft(bdb, completeAnswers(), null));
    expect(await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash: 'x' }))).toEqual({
      outcome: 'not_frozen',
    });
    expect(await charterRows()).toBe(0);
  });

  it('refuses when the active charter moved since the draft was based', async () => {
    const shownHash = await frozenDraft();
    // Someone installed a charter after this draft started from "none".
    await withBusiness(A, (bdb) => installCharter(bdb, buildCharter({ version: 'other-1' })));

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBe('other-1');
    expect(await charterRows()).toBe(1);
    expect(await changeRows()).toBe(0);
    expect(await draftRows()).toBe(1);
  });

  it('refuses when the base version no longer loads', async () => {
    await withBusiness(A, (bdb) => installCharter(bdb, buildCharter({ version: 'base-1' })));
    const shownHash = await frozenDraft(completeAnswers(), 'base-1');
    await withBusiness(A, (bdb) => replaceDraft(bdb, completeAnswers(), 'gone-1'));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00.000Z')));

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBe('base-1');
  });

  it('replaces an active charter that no longer parses (the "edit the rules" door)', async () => {
    await withBusiness(A, (bdb) => installCharter(bdb, buildCharter({ version: 'broken-1' })));
    await testDb().query(
      `UPDATE charter_versions
          SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1 AND charter_version = 'broken-1'`,
      [A],
    );
    // The summary computes the hash with no previous charter: none can be read.
    await withBusiness(A, (bdb) => replaceDraft(bdb, completeAnswers(), 'broken-1'));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00.000Z')));
    const draft = await withBusiness(A, (bdb) => loadDraft(bdb));
    if (draft === null) throw new Error('draft missing');
    const shownHash = shownHashFor(draft, A, null);

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(outcome.outcome).toBe('installed');
    if (outcome.outcome !== 'installed') return;
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBe(outcome.charterVersion);
  });

  it('two concurrent first installs: exactly one wins', async () => {
    const shownHash = await frozenDraft();

    const outcomes = await Promise.all([
      withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash })),
      withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash })),
    ]);

    const kinds = outcomes.map((o) => o.outcome).sort();
    expect(kinds.filter((k) => k === 'installed')).toHaveLength(1);
    expect(['stale', 'incomplete']).toContain(kinds.find((k) => k !== 'installed'));
    expect(await charterRows()).toBe(1);
    expect(await changeRows()).toBe(1);
    expect(await draftRows()).toBe(0);
  });

  it('an edit supersedes the previous charter', async () => {
    const first = await withBusiness(A, async (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash: await frozenDraft() }));
    if (first.outcome !== 'installed') throw new Error(`first install: ${first.outcome}`);

    const edited = completeAnswers();
    edited.business.employees = 9;
    const shownHash = await frozenDraft(edited, first.charterVersion);
    const second = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, mailboxPreflight: NO_PREFLIGHT, shownHash }));

    expect(second.outcome).toBe('installed');
    if (second.outcome !== 'installed') return;
    expect(second.charterVersion).not.toBe(first.charterVersion);
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBe(second.charterVersion);
    expect((await withBusiness(A, (bdb) => loadCharterVersion(bdb, second.charterVersion)))?.supersedes).toBe(first.charterVersion);
    expect(await charterRows()).toBe(2);
    const { rows } = await testDb().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'charter_change' ORDER BY seq`,
      [A],
    );
    expect(rows[1]?.reason).toBe(
      `charter signed through the setup interview by ${OWNER}, superseding ${first.charterVersion}`,
    );
  });
});

describe('a mailbox the signature adds', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('a failing preflight refuses, and nothing is installed or deleted', async () => {
    const answers = completeAnswers();
    answers.reading = { mailbox: 'google', documents: false };
    const shownHash = await frozenDraft(answers);
    const asked: string[] = [];

    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, shownHash, mailboxPreflight: async (provider) => {
        asked.push(provider);
        return 'חסר GOOGLE_OAUTH_CLIENT_SECRET.';
      } }));

    expect(outcome).toEqual({ outcome: 'preflight_failed', reason: 'חסר GOOGLE_OAUTH_CLIENT_SECRET.' });
    expect(asked).toEqual(['google']);
    expect(await withBusiness(A, (bdb) => activeCharterVersion(bdb))).toBeNull();
    expect(await charterRows()).toBe(0);
    expect(await changeRows()).toBe(0);
    expect(await draftRows()).toBe(1);
  });

  it('a passing preflight installs', async () => {
    const answers = completeAnswers();
    answers.reading = { mailbox: 'microsoft', documents: false };
    const shownHash = await frozenDraft(answers);
    const outcome = await withBusiness(A, (bdb) => signAndInstallInterview(bdb, { username: OWNER, shownHash, mailboxPreflight: async () => null }));
    expect(outcome.outcome).toBe('installed');
  });
});

describe('previousForDraft', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reads an unparsable base as "no previous" — and only a parse failure', async () => {
    await withBusiness(A, (bdb) => installCharter(bdb, buildCharter({ version: 'broken-1' })));
    await testDb().query(
      `UPDATE charter_versions SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1`,
      [A],
    );
    expect(await withBusiness(A, (bdb) => previousForDraft(bdb, { baseCharterVersion: 'broken-1' }))).toEqual({ ok: true, previous: null });
  });

  it('rethrows an error that is not a parse failure', async () => {
    const down: BusinessDb = {
      businessId: A,
      inTransaction: false,
      query: (async () => {
        throw new Error('connection terminated');
      }) as unknown as BusinessDb['query'],
    };
    await expect(previousForDraft(down, { baseCharterVersion: 'v1' })).rejects.toThrow('connection terminated');
  });
});
