import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, withBusiness } from '../../db/pool.js';
import { resetDatabase, testDb } from '../../test/db.js';
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
  const { rows } = await testDb().query<{ n: string }>(
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
    const first = await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    await withBusiness(A, (bdb) => saveSection(bdb, 'hours', HOURS));

    const draft = await withBusiness(A, (bdb) => loadDraft(bdb));
    expect(draft?.draftId).toBe(first.draftId);
    expect(draft?.answers.business).toEqual(BUSINESS);
    expect(draft?.answers.hours).toEqual(HOURS);
    expect(await rowCount(A)).toBe(1);
  });

  it('saveSection clears frozen_at', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00Z')));
    expect((await withBusiness(A, (bdb) => loadDraft(bdb)))?.frozenAt).not.toBeNull();

    await withBusiness(A, (bdb) => saveSection(bdb, 'hours', HOURS));
    expect((await withBusiness(A, (bdb) => loadDraft(bdb)))?.frozenAt).toBeNull();
  });

  it('freezeDraft keeps the first freeze', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    const t1 = new Date('2026-10-31T10:00:00Z');
    const t2 = new Date('2026-10-31T11:00:00Z');

    expect((await withBusiness(A, (bdb) => freezeDraft(bdb, t1))).getTime()).toBe(t1.getTime());
    expect((await withBusiness(A, (bdb) => freezeDraft(bdb, t2))).getTime()).toBe(t1.getTime());
    expect((await withBusiness(A, (bdb) => loadDraft(bdb)))?.frozenAt?.getTime()).toBe(t1.getTime());
  });

  it('drafts are business-scoped', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    expect(await withBusiness(B, (bdb) => loadDraft(bdb))).toBeNull();
  });

  it('saveSection refuses a value its section schema rejects, and writes nothing', async () => {
    await expect(withBusiness(A, (bdb) => saveSection(bdb, 'hours', { ...HOURS, timezone: 'Mars/Olympus' }))).rejects.toThrow();
    expect(await rowCount(A)).toBe(0);
  });

  it('baseCharterVersion is written on insert only', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS, { baseCharterVersion: 'v1' }));
    const second = await withBusiness(A, (bdb) => saveSection(bdb, 'hours', HOURS, { baseCharterVersion: 'v2' }));
    expect(second.baseCharterVersion).toBe('v1');
  });

  it('replaceDraft overwrites the answers and clears frozen_at', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    await withBusiness(A, (bdb) => freezeDraft(bdb, new Date('2026-10-31T10:00:00Z')));

    const replaced = await withBusiness(A, (bdb) => replaceDraft(bdb, { hours: HOURS }, 'v7'));
    expect(replaced.answers).toEqual({ hours: HOURS });
    expect(replaced.frozenAt).toBeNull();
    expect(replaced.baseCharterVersion).toBe('v7');
    expect(await rowCount(A)).toBe(1);
  });

  it('loadDraft throws on a stored draft that does not parse, rather than reading it as no draft', async () => {
    await testDb().query(
      `INSERT INTO charter_interview_drafts (draft_id, business_id, answers)
       VALUES ('D-corrupt', $1, $2::jsonb)`,
      [A, JSON.stringify({ hours: { timezone: 'nowhere' } })],
    );
    await expect(withBusiness(A, (bdb) => loadDraft(bdb))).rejects.toThrow(/business-a/);
  });

  it('deleteDraft removes only that business', async () => {
    await withBusiness(A, (bdb) => saveSection(bdb, 'business', BUSINESS));
    await withBusiness(B, (bdb) => saveSection(bdb, 'business', BUSINESS));
    await withBusiness(A, (bdb) => deleteDraft(bdb));
    expect(await withBusiness(A, (bdb) => loadDraft(bdb))).toBeNull();
    expect(await withBusiness(B, (bdb) => loadDraft(bdb))).not.toBeNull();
  });
});
