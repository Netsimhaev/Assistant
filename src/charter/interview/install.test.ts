import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { loadAutonomyMode } from '../../governance/autonomy-mode.js';
import { resetDatabase } from '../../test/db.js';
import { buildCharter } from '../../test/fixtures.js';
import { activeCharterVersion, installCharter, loadCharterVersion } from '../store.js';
import { InterviewAnswers } from './answers.js';
import { freezeDraft, loadDraft, replaceDraft, saveSection } from './draft-store.js';
import { shownHashFor, signAndInstallInterview } from './install.js';
import { completeAnswers } from './test-answers.js';

const A = 'business-a';
const OWNER = 'dana';

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(sql, params);
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
  await replaceDraft(A, answers, base);
  await freezeDraft(A, new Date('2026-10-31T10:00:00.000Z'));
  const draft = await loadDraft(A);
  if (draft === null) throw new Error('draft missing');
  const previous = base === null ? null : await loadCharterVersion(base, A);
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

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome.outcome).toBe('installed');
    if (outcome.outcome !== 'installed') return;
    expect(await activeCharterVersion(A)).toBe(outcome.charterVersion);
    const installed = await loadCharterVersion(outcome.charterVersion, A);
    expect(installed?.signature.signedByPersonId).toBe(OWNER);
    expect(installed?.signature.method).toBe('dashboard_click');
    expect(await changeRows()).toBe(1);
    expect(await draftRows()).toBe(0);

    // The audit reason names who signed, never what was answered.
    const { rows } = await getPool().query<{ reason: string }>(
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
    expect(await loadAutonomyMode({ businessId: A })).toBe('off');

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome).toMatchObject({ outcome: 'installed', modeApplied: true });
    expect(await loadAutonomyMode({ businessId: A })).toBe('learn');
  });

  it('refuses a sign whose shown hash is stale', async () => {
    const shownHash = await frozenDraft();
    const draft = await loadDraft(A);
    // An edit unfreezes; the review is reached again and freezes a new moment.
    await saveSection(A, 'business', { ...completeAnswers().business, employees: 7 });
    await freezeDraft(A, new Date('2026-10-31T11:00:00.000Z'));
    expect((await loadDraft(A))?.frozenAt?.getTime()).not.toBe(draft?.frozenAt?.getTime());

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome).toEqual({ outcome: 'hash_mismatch' });
    expect(await charterRows()).toBe(0);
    expect(await activeCharterVersion(A)).toBeNull();
    expect(await draftRows()).toBe(1);
  });

  it('refuses an unfrozen draft and a missing or partial one', async () => {
    expect(await signAndInstallInterview({ businessId: A, username: OWNER, shownHash: 'x' })).toEqual({
      outcome: 'incomplete',
    });

    await saveSection(A, 'business', completeAnswers().business);
    await freezeDraft(A, new Date('2026-10-31T10:00:00.000Z'));
    expect(await signAndInstallInterview({ businessId: A, username: OWNER, shownHash: 'x' })).toEqual({
      outcome: 'incomplete',
    });

    await replaceDraft(A, completeAnswers(), null);
    expect(await signAndInstallInterview({ businessId: A, username: OWNER, shownHash: 'x' })).toEqual({
      outcome: 'not_frozen',
    });
    expect(await charterRows()).toBe(0);
  });

  it('refuses when the active charter moved since the draft was based', async () => {
    const shownHash = await frozenDraft();
    // Someone installed a charter after this draft started from "none".
    await installCharter(buildCharter({ version: 'other-1' }), { businessId: A });

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(await activeCharterVersion(A)).toBe('other-1');
    expect(await charterRows()).toBe(1);
    expect(await changeRows()).toBe(0);
    expect(await draftRows()).toBe(1);
  });

  it('refuses when the base version no longer loads', async () => {
    await installCharter(buildCharter({ version: 'base-1' }), { businessId: A });
    const shownHash = await frozenDraft(completeAnswers(), 'base-1');
    await replaceDraft(A, completeAnswers(), 'gone-1');
    await freezeDraft(A, new Date('2026-10-31T10:00:00.000Z'));

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome).toEqual({ outcome: 'stale' });
    expect(await activeCharterVersion(A)).toBe('base-1');
  });

  it('replaces an active charter that no longer parses (the "edit the rules" door)', async () => {
    await installCharter(buildCharter({ version: 'broken-1' }), { businessId: A });
    await getPool().query(
      `UPDATE charter_versions
          SET charter = jsonb_set(charter::jsonb, '{schemaVersion}', to_jsonb('0'::text))
        WHERE business_id = $1 AND charter_version = 'broken-1'`,
      [A],
    );
    // The summary computes the hash with no previous charter: none can be read.
    await replaceDraft(A, completeAnswers(), 'broken-1');
    await freezeDraft(A, new Date('2026-10-31T10:00:00.000Z'));
    const draft = await loadDraft(A);
    if (draft === null) throw new Error('draft missing');
    const shownHash = shownHashFor(draft, A, null);

    const outcome = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(outcome.outcome).toBe('installed');
    if (outcome.outcome !== 'installed') return;
    expect(await activeCharterVersion(A)).toBe(outcome.charterVersion);
  });

  it('two concurrent first installs: exactly one wins', async () => {
    const shownHash = await frozenDraft();

    const outcomes = await Promise.all([
      signAndInstallInterview({ businessId: A, username: OWNER, shownHash }),
      signAndInstallInterview({ businessId: A, username: OWNER, shownHash }),
    ]);

    const kinds = outcomes.map((o) => o.outcome).sort();
    expect(kinds.filter((k) => k === 'installed')).toHaveLength(1);
    expect(['stale', 'incomplete']).toContain(kinds.find((k) => k !== 'installed'));
    expect(await charterRows()).toBe(1);
    expect(await changeRows()).toBe(1);
    expect(await draftRows()).toBe(0);
  });

  it('an edit supersedes the previous charter', async () => {
    const first = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash: await frozenDraft() });
    if (first.outcome !== 'installed') throw new Error(`first install: ${first.outcome}`);

    const edited = completeAnswers();
    edited.business.employees = 9;
    const shownHash = await frozenDraft(edited, first.charterVersion);
    const second = await signAndInstallInterview({ businessId: A, username: OWNER, shownHash });

    expect(second.outcome).toBe('installed');
    if (second.outcome !== 'installed') return;
    expect(second.charterVersion).not.toBe(first.charterVersion);
    expect(await activeCharterVersion(A)).toBe(second.charterVersion);
    expect((await loadCharterVersion(second.charterVersion, A))?.supersedes).toBe(first.charterVersion);
    expect(await charterRows()).toBe(2);
    const { rows } = await getPool().query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE business_id = $1 AND kind = 'charter_change' ORDER BY seq`,
      [A],
    );
    expect(rows[1]?.reason).toBe(
      `charter signed through the setup interview by ${OWNER}, superseding ${first.charterVersion}`,
    );
  });
});
