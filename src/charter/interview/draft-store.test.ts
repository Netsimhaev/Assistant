import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../db/pool.js';
import { resetDatabase } from '../../test/db.js';
import type { InterviewAnswers } from './answers.js';
import { deleteDraft, freezeDraft, loadDraft, replaceDraft, saveSection } from './draft-store.js';

const A = 'business-a';
const B = 'business-b';

const BUSINESS: InterviewAnswers['business'] = {
  description: 'מספרה שכונתית',
  legalName: 'ספר בע"מ',
  tradeName: 'הספר',
  vertical: 'beauty',
  employees: 2,
  expectations: 'לענות למיילים',
  notDone: [],
  keyFacts: [],
};

const HOURS: InterviewAnswers['hours'] = {
  workweek: ['sun', 'mon'],
  open: '09:00',
  close: '18:00',
  quietHours: null,
  timezone: 'Asia/Jerusalem',
};

async function rowCount(businessId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    'SELECT count(*)::text AS n FROM charter_interview_drafts WHERE business_id = $1',
    [businessId],
  );
  return Number(rows[0]?.n ?? '0');
}

describe('interview draft store', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('saveSection creates one draft per business and merges sections', async () => {
    const first = await saveSection(A, 'business', BUSINESS);
    await saveSection(A, 'hours', HOURS);

    const draft = await loadDraft(A);
    expect(draft?.draftId).toBe(first.draftId);
    expect(draft?.answers.business).toEqual(BUSINESS);
    expect(draft?.answers.hours).toEqual(HOURS);
    expect(await rowCount(A)).toBe(1);
  });

  it('saveSection clears frozen_at', async () => {
    await saveSection(A, 'business', BUSINESS);
    await freezeDraft(A, new Date('2026-10-31T10:00:00Z'));
    expect((await loadDraft(A))?.frozenAt).not.toBeNull();

    await saveSection(A, 'hours', HOURS);
    expect((await loadDraft(A))?.frozenAt).toBeNull();
  });

  it('freezeDraft keeps the first freeze', async () => {
    await saveSection(A, 'business', BUSINESS);
    const t1 = new Date('2026-10-31T10:00:00Z');
    const t2 = new Date('2026-10-31T11:00:00Z');

    expect((await freezeDraft(A, t1)).getTime()).toBe(t1.getTime());
    expect((await freezeDraft(A, t2)).getTime()).toBe(t1.getTime());
    expect((await loadDraft(A))?.frozenAt?.getTime()).toBe(t1.getTime());
  });

  it('drafts are business-scoped', async () => {
    await saveSection(A, 'business', BUSINESS);
    expect(await loadDraft(B)).toBeNull();
  });

  it('saveSection refuses a value its section schema rejects, and writes nothing', async () => {
    await expect(saveSection(A, 'hours', { ...HOURS, timezone: 'Mars/Olympus' })).rejects.toThrow();
    expect(await rowCount(A)).toBe(0);
  });

  it('baseCharterVersion is written on insert only', async () => {
    await saveSection(A, 'business', BUSINESS, { baseCharterVersion: 'v1' });
    const second = await saveSection(A, 'hours', HOURS, { baseCharterVersion: 'v2' });
    expect(second.baseCharterVersion).toBe('v1');
  });

  it('replaceDraft overwrites the answers and clears frozen_at', async () => {
    await saveSection(A, 'business', BUSINESS);
    await freezeDraft(A, new Date('2026-10-31T10:00:00Z'));

    const replaced = await replaceDraft(A, { hours: HOURS }, 'v7');
    expect(replaced.answers).toEqual({ hours: HOURS });
    expect(replaced.frozenAt).toBeNull();
    expect(replaced.baseCharterVersion).toBe('v7');
    expect(await rowCount(A)).toBe(1);
  });

  it('loadDraft throws on a stored draft that does not parse, rather than reading it as no draft', async () => {
    await getPool().query(
      `INSERT INTO charter_interview_drafts (draft_id, business_id, answers)
       VALUES ('D-corrupt', $1, $2::jsonb)`,
      [A, JSON.stringify({ hours: { timezone: 'nowhere' } })],
    );
    await expect(loadDraft(A)).rejects.toThrow(/business-a/);
  });

  it('deleteDraft removes only that business', async () => {
    await saveSection(A, 'business', BUSINESS);
    await saveSection(B, 'business', BUSINESS);
    await deleteDraft(A, getPool());
    expect(await loadDraft(A)).toBeNull();
    expect(await loadDraft(B)).not.toBeNull();
  });
});
