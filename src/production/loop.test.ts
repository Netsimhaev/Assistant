/**
 * The production loop, end to end on a real database with stubs for every
 * external seam: the drafter, the PDF printer, the page renderer and the
 * judge. Check 1 is the real `runCheck1`; the page renderer stands in for
 * LibreOffice with mammoth's raw text of the built .docx (the same stand-in
 * `check1.test.ts` uses), so a passing letter really passes check 1.
 *
 * Every negative test also shows the code it is about ran: the cap test
 * asserts the cap's own reason, the timeout test the draft-deadline reason.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mammoth from 'mammoth';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCharter } from '../charter/store.js';
import { closePool, withBusiness } from '../db/pool.js';
import type { DocumentSpec, DocxSpec, PdfSpec } from '../domain/document-spec.js';
import { createJob, loadJob, transition } from '../orchestrator/jobs.js';
import type { DraftRequest, Drafter } from '../sdk/doc-drafter.js';
import type { DocJudge } from '../sdk/doc-judge.js';
import { resetDatabase, TEST_BUSINESS, testDb } from '../test/db.js';
import { buildCharter } from '../test/fixtures.js';
import { runCheck1, type Check1Input } from './check1.js';
import {
  CHECK2_UNJUDGED_HE,
  FILE_CHANGED_REASON,
  productionCapReason,
  runDocumentProductions,
  type ProductionFinished,
  type RunProductionsOptions,
} from './loop.js';
import type { PageRenderer } from './page-images.js';
import type { PdfAssets } from './render-html.js';
import type { PdfPrinter } from './render-pdf.js';
import { PRODUCTION_TOOLS_MISSING_REASON, RENDER_ERROR_HE } from './render-error.js';
import { createProduction, EMPTY_WORK, latestVersion, loadProduction } from './store.js';

const B = 'test-business';
const NOW = new Date('2026-11-04T10:00:00Z');
const SRC = { kind: 'instruction' } as const;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const letter = (title = 'מכתב ללקוח'): DocxSpec => ({
  format: 'docx',
  language: 'he',
  kind: 'letter',
  title,
  filename: 'letter',
  style: { theme: 'clean', accent: 'navy' },
  sources: [SRC],
  blocks: [
    { type: 'heading', level: 1, text: 'שלום רב' },
    { type: 'paragraph', text: 'תודה על הפנייה, נשמח לעזור בכל שאלה' },
  ],
});

/** A title that the renderer stub turns into 61 pages — a real check-1 `cap_exceeded`. */
const BAD_TITLE = 'גרסה ארוכה מדי';

let root: string;
let charterVersion: string;

function drafterOf(specs: (DocumentSpec | 'undrafted' | 'hang')[]) {
  const calls: DraftRequest[] = [];
  const fn: Drafter = async (request) => {
    calls.push(request);
    const next = specs[Math.min(calls.length - 1, specs.length - 1)]!;
    if (next === 'undrafted') return { status: 'undrafted', reason: 'no' };
    if (next === 'hang') return new Promise(() => {});
    return { status: 'drafted', spec: next };
  };
  return { fn, calls };
}

const passingJudge: DocJudge = async () => ({
  status: 'judged',
  raw: '{}',
  criteria: ['answers_request', 'language_correct', 'order_as_seen', 'structure_fits_kind', 'legible_professional'].map(
    (id) => ({ id, statement: id, severity: 'must' as const, passed: true, detail: '' }),
  ),
});

function rendererOf() {
  const calls: { format: string; flaggedPages: readonly number[] | undefined }[] = [];
  const fn: PageRenderer = async (file, _signal, options) => {
    calls.push({ format: file.format, flaggedPages: options?.flaggedPages });
    const text = file.format === 'docx' ? (await mammoth.extractRawText({ buffer: file.bytes })).value : 'טקסט';
    return { pages: [PNG], text, pageCount: text.includes(BAD_TITLE) ? 61 : 1, textTruncated: false };
  };
  return { fn, calls };
}

const neverPrinter: PdfPrinter = async () => {
  throw new Error('no pdf in this test');
};

async function originJob(): Promise<string> {
  const job = await withBusiness(B, (db) => createJob(db, { charterVersion, provenance: 'boss', title: 'הפקת מסמך' }));
  for (const to of ['understand', 'plan', 'execute', 'followup'] as const) {
    await withBusiness(B, (db) => transition(db, job.jobId, { to, actor: 'orchestrator', reason: 'test' }));
  }
  return job.jobId;
}

async function produce(over: Partial<Parameters<typeof createProduction>[1]> = {}): Promise<{ id: string; jobId: string }> {
  const jobId = await originJob();
  const id = await withBusiness(B, (db) => createProduction(db, {
    originJobId: jobId,
    instructionText: 'תכיני מכתב תודה ללקוח',
    textOrigin: 'typed',
    format: 'docx',
    language: 'he',
    kind: 'letter',
    destination: { mode: 'save', folder: null },
    sourceDocumentIds: [],
    ...over,
  }));
  return { id, jobId };
}

function run(over: Partial<RunProductionsOptions> & { drafter: Drafter }) {
  const finished: ProductionFinished[] = [];
  const renderer = rendererOf();
  const promise = withBusiness(B, (db) => runDocumentProductions(db, {
    now: NOW,
    documentRoot: root,
    judge: passingJudge,
    printer: neverPrinter,
    renderer: renderer.fn,
    // Real time is irrelevant here; the budget tests pass a clock of their own.
    clock: () => 0,
    budgetMs: Number.MAX_SAFE_INTEGER,
    onFinished: async (f) => {
      finished.push(f);
    },
    ...over,
  }));
  return { promise, finished, renderer };
}

beforeEach(async () => {
  await resetDatabase();
  charterVersion = (await withBusiness(B, (bdb) => installCharter(bdb, buildCharter()))).charterVersion;
  root = await mkdtemp(join(tmpdir(), 'produced-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await closePool();
});

describe('runDocumentProductions', () => {
  it('happy path reaches ready, writes one version, closes the origin job', async () => {
    const { id, jobId } = await produce();
    const drafter = drafterOf([letter()]);
    const r = run({ drafter: drafter.fn });
    const result = await r.promise;

    expect(result).toMatchObject({ ready: 1, failedChecks: 0, failed: 0, skipped: 0, errored: [] });
    expect(drafter.calls).toHaveLength(1);
    expect(drafter.calls[0]!.today).toBe('2026-11-04');
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('ready');
    expect(p?.attempt).toBe(0);
    expect(p?.work.finished).toBe(true);

    const { rows } = await testDb().query('SELECT * FROM document_versions WHERE production_id = $1', [id]);
    expect(rows).toHaveLength(1);
    const version = await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id));
    const bytes = await readFile(join(root, version!.storedPath));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(version!.sha256);
    expect(version!.storedPath).toBe(join('produced', B, id, `${version!.versionId}.docx`));
    expect(version!.check1).toMatchObject({ passed: true, findings: [] });
    expect(version!.check2).toMatchObject({ passed: true, status: 'judged' });
    // Rendered once per attempt: check 1's text and check 2's images come from one render.
    expect(r.renderer.calls).toHaveLength(1);
    expect(await readFile(join(root, (version!.check2 as { previewPath: string }).previewPath))).toEqual(PNG);

    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('closed');
    expect(r.finished).toEqual([{ productionId: id, versionId: version!.versionId, stage: 'ready', reason: null }]);

    // The audit row carries no content: no title, no instruction, no file name.
    const audit = await testDb().query<{ reason: string; input_hash: string }>(
      `SELECT reason, input_hash FROM audit_log WHERE kind = 'document_production'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.reason).not.toMatch(/מכתב|תודה|letter/);
  });

  it('check1 failure twice then pass → ready with attempt 2', async () => {
    const { id } = await produce();
    const drafter = drafterOf([letter(BAD_TITLE), letter(BAD_TITLE), letter()]);
    const r = run({ drafter: drafter.fn });
    const result = await r.promise;

    expect(result).toMatchObject({ ready: 1, errored: [] });
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('ready');
    expect(p?.attempt).toBe(2);
    expect(drafter.calls).toHaveLength(3);
    // The fix rounds carried the failing spec and check 1's findings (fenced), never in fixInstruction.
    expect(drafter.calls[0]!.previous).toBeUndefined();
    expect(drafter.calls[1]!.previous?.spec.title).toBe(BAD_TITLE);
    expect(drafter.calls[1]!.previous?.findings.some((f) => f.he.includes('המסמך ארוך מהמותר'))).toBe(true);
    expect(drafter.calls[1]!.fixInstruction).toBeUndefined();
    const { rows } = await testDb().query<{ version_no: number }>(
      'SELECT version_no FROM document_versions WHERE production_id = $1 ORDER BY version_no',
      [id],
    );
    expect(rows.map((x) => x.version_no)).toEqual([1, 2, 3]);
  });

  it('three failures → failed_checks; card created with the findings', async () => {
    const { id, jobId } = await produce();
    const drafter = drafterOf([letter(BAD_TITLE)]);
    const r = run({ drafter: drafter.fn });
    const result = await r.promise;

    expect(result).toMatchObject({ failedChecks: 1, ready: 0, errored: [] });
    expect(drafter.calls).toHaveLength(3);
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('failed_checks');
    expect(p?.attempt).toBe(2);
    expect(p?.findings).toContainEqual(
      expect.objectContaining({ check: 'check1', code: 'cap_exceeded', he: 'המסמך ארוך מהמותר' }),
    );
    const version = await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id));
    expect(version?.versionNo).toBe(3);
    expect(r.finished).toEqual([{ productionId: id, versionId: version!.versionId, stage: 'failed_checks', reason: null }]);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('closed');
  });

  it('a crash after building (simulate by throwing after saveVersion) resumes at check1 and does not call the drafter again', async () => {
    const { id } = await produce();
    const drafter = drafterOf([letter()]);
    let crash = true;
    const first = run({
      drafter: drafter.fn,
      checkpoint: () => {
        if (crash) {
          crash = false;
          throw new Error('simulated crash');
        }
      },
    });
    const crashed = await first.promise;
    expect(crashed?.errored).toEqual([{ productionId: id, error: 'simulated crash' }]);
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.stage).toBe('building');
    expect((await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id)))?.versionNo).toBe(1);
    expect(first.renderer.calls).toHaveLength(0);

    const second = run({ drafter: drafter.fn });
    const resumed = await second.promise;
    expect(resumed).toMatchObject({ ready: 1, errored: [] });
    expect(drafter.calls).toHaveLength(1);
    // Resumed: building re-used version 1 (no second version), then check1 and check2 ran.
    const { rows } = await testDb().query('SELECT 1 FROM document_versions WHERE production_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(second.renderer.calls).toHaveLength(1);
  });

  it('a resumed pdf check1 gets the same HTML string the PDF was printed from', async () => {
    const pdfSpec: PdfSpec = { ...letter(), format: 'pdf' };
    const { id } = await produce({ format: 'pdf' });
    const FONT = 'data:font/ttf;base64,AAEAAA==';
    const assets: PdfAssets = {
      fonts: { hebrewRegular: FONT, hebrewBold: FONT, latinRegular: FONT, latinBold: FONT },
      images: new Map(),
    };
    const printed: string[] = [];
    const printer: PdfPrinter = async (html) => {
      printed.push(html);
      return Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
    };
    const seen: (string | undefined)[] = [];
    const check1 = async (input: Check1Input) => {
      seen.push(input.html);
      return { passed: true, findings: [] };
    };
    const drafter = drafterOf([pdfSpec]);
    const common = { drafter: drafter.fn, printer, pdfAssets: async () => assets, check1 };
    let crash = true;
    await run({
      ...common,
      checkpoint: () => {
        if (crash) {
          crash = false;
          throw new Error('crash');
        }
      },
    }).promise;
    expect(seen).toHaveLength(0);
    const resumed = await run(common).promise;
    expect(resumed).toMatchObject({ ready: 1, errored: [] });
    expect(printed).toHaveLength(1);
    expect(seen).toEqual([printed[0]]);
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.stage).toBe('ready');
  });

  it('the 21st production of the local day is refused with the Hebrew cap reason and the drafter never runs', async () => {
    // Twenty draft calls already today (local midnight 2026-11-03T22:00Z).
    for (let i = 0; i < 20; i += 1) {
      const { id } = await produce();
      await testDb().query(
        `UPDATE document_productions SET stage = 'ready', work = $2, created_at = '2026-11-04T05:00:00Z' WHERE production_id = $1`,
        [id, { ...EMPTY_WORK, drafted: true, finished: true }],
      );
    }
    const { id, jobId } = await produce();
    const drafter = drafterOf([letter()]);
    const r = run({ drafter: drafter.fn });
    const result = await r.promise;

    expect(drafter.calls).toHaveLength(0);
    expect(result).toMatchObject({ failed: 1, errored: [] });
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('failed');
    expect(p?.work.reason).toBe(productionCapReason(20));
    expect(p?.work.drafted).toBe(false);
    expect(r.finished).toEqual([{ productionId: id, versionId: null, stage: 'failed', reason: productionCapReason(20) }]);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
  });

  it('the 20th is not refused (the cap counts calls already made)', async () => {
    for (let i = 0; i < 19; i += 1) {
      const { id } = await produce();
      await testDb().query(
        `UPDATE document_productions SET stage = 'ready', work = $2, created_at = '2026-11-04T05:00:00Z' WHERE production_id = $1`,
        [id, { ...EMPTY_WORK, drafted: true, finished: true }],
      );
    }
    await produce();
    const drafter = drafterOf([letter()]);
    expect(await run({ drafter: drafter.fn }).promise).toMatchObject({ ready: 1 });
    expect(drafter.calls).toHaveLength(1);
  });

  it('budget exhausted stops the pass and leaves the rest queued', async () => {
    const a = await produce();
    const b = await produce();
    let t = 0;
    const drafter = drafterOf([letter()]);
    const slow: Drafter = async (request) => {
      t += 200_000;
      return drafter.fn(request);
    };
    const result = await run({ drafter: slow, clock: () => t, budgetMs: 120_000 }).promise;

    expect(drafter.calls).toHaveLength(1);
    expect(result).toMatchObject({ ready: 0, errored: [] });
    expect((await withBusiness(B, (db) => loadProduction(db, a.id)))?.stage).toBe('building');
    expect((await withBusiness(B, (db) => loadProduction(db, b.id)))?.stage).toBe('queued');
    // The lease was released: the next pass picks up where this one stopped.
    expect((await withBusiness(B, (db) => loadProduction(db, a.id)))?.leasedBy).toBeNull();
    t = 0;
    const next = await run({ drafter: drafter.fn, clock: () => 0 }).promise;
    expect(next).toMatchObject({ ready: 2 });
  });

  it('drafter timeout → failed with reason, origin job failed', async () => {
    const { id, jobId } = await produce();
    const drafter = drafterOf(['hang']);
    const r = run({ drafter: drafter.fn, deadlines: { draft: 20 } });
    const result = await r.promise;

    expect(drafter.calls).toHaveLength(1);
    expect(result).toMatchObject({ failed: 1, errored: [] });
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('failed');
    expect(p?.work.reason).toBe('ניסוח המסמך לא הסתיים בזמן');
    expect(r.finished[0]).toMatchObject({ stage: 'failed', reason: 'ניסוח המסמך לא הסתיים בזמן', versionId: null });
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
  });

  it('an undrafted outcome → failed; a render error → failed with its Hebrew reason', async () => {
    const one = await produce();
    await run({ drafter: drafterOf(['undrafted']).fn }).promise;
    expect((await withBusiness(B, (db) => loadProduction(db, one.id)))?.work.reason).toBe('לא הצלחתי לנסח את המסמך מהבקשה ומהמקורות');

    const { id } = await produce({ format: 'pdf' });
    const pdfSpec: PdfSpec = { ...letter(), format: 'pdf' };
    const r = await run({
      drafter: drafterOf([pdfSpec]).fn,
      pdfAssets: async () => {
        const { SpecRenderError } = await import('./render-error.js');
        throw new SpecRenderError('pdf_memory', 'test');
      },
    }).promise;
    expect(r).toMatchObject({ failed: 1 });
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.work.reason).toBe('בניית ה-PDF חרגה ממגבלת הזיכרון של השרת');
  });

  it('an unjudged check 2 fails closed into a fix round', async () => {
    const { id } = await produce();
    const drafter = drafterOf([letter()]);
    const unjudged: DocJudge = async () => ({ status: 'unjudged', reason: 'x', raw: '' });
    const result = await run({ drafter: drafter.fn, judge: unjudged }).promise;
    expect(result).toMatchObject({ failedChecks: 1 });
    expect(drafter.calls).toHaveLength(3);
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.findings).toEqual([
      { check: 'check2', code: 'unjudged', where: 'document', he: CHECK2_UNJUDGED_HE },
    ]);
  });

  it('a failed must criterion fails check 2; its detail reaches the next draft fenced, not as fixInstruction', async () => {
    await produce();
    const drafter = drafterOf([letter()]);
    let n = 0;
    const judge: DocJudge = async (request) => {
      n += 1;
      const out = await passingJudge(request);
      if (out.status !== 'judged' || n > 1) return out;
      return {
        ...out,
        criteria: out.criteria.map((c) => (c.id === 'order_as_seen' ? { ...c, passed: false, detail: 'שורה 2 הפוכה' } : c)),
      };
    };
    const result = await run({ drafter: drafter.fn, judge }).promise;
    expect(result).toMatchObject({ ready: 1 });
    expect(drafter.calls).toHaveLength(2);
    expect(drafter.calls[1]!.previous?.findings.some((f) => f.he.includes('שורה 2 הפוכה'))).toBe(true);
    expect(drafter.calls[1]!.fixInstruction).toBeUndefined();
  });

  it('returns null when production tools are unavailable and nothing is injected', async () => {
    await produce();
    expect(await withBusiness(B, (db) => runDocumentProductions(db))).toBeNull();
    expect(
      await withBusiness(B, (db) => runDocumentProductions(db, {
        production: { available: false, sofficePath: null, chromiumPath: null },
      })),
    ).toBeNull();
  });

  it('runs check1 for real: a passing letter has no findings', async () => {
    // Guard against a stubbed-out check 1 in the happy path: the real one is the default.
    await produce();
    const seen: unknown[] = [];
    const check1 = async (input: Check1Input) => {
      const r = await runCheck1(input);
      seen.push(r);
      return r;
    };
    await run({ drafter: drafterOf([letter()]).fn, check1 }).promise;
    expect(seen).toEqual([{ passed: true, findings: [] }]);
  });
});

/** A spec validateSpec refuses: 4729 appears in no source. */
const ungrounded = (): DocxSpec => ({
  ...letter(),
  blocks: [{ type: 'paragraph', text: 'המחיר הוא 4729 שקלים' }],
});

function crashAt(event: 'version_saved' | 'check1_saved' | 'check2_saved') {
  let armed = true;
  return (at: string) => {
    if (at === event && armed) {
      armed = false;
      throw new Error('crash');
    }
  };
}

describe('fix round 1', () => {
  it('missing tools: the pass is null, but queued rows end failed with the tools reason and the origin job fails', async () => {
    const { id, jobId } = await produce();
    const finished: ProductionFinished[] = [];
    const result = await withBusiness(B, (db) => runDocumentProductions(db, {
      now: NOW,
      production: { available: false, sofficePath: null, chromiumPath: null },
      onFinished: async (f) => {
        finished.push(f);
      },
    }));
    expect(result).toBeNull();
    const p = await withBusiness(B, (db) => loadProduction(db, id));
    expect(p?.stage).toBe('failed');
    expect(p?.work.reason).toBe(PRODUCTION_TOOLS_MISSING_REASON);
    expect(p?.work.finished).toBe(true);
    expect(finished).toEqual([{ productionId: id, versionId: null, stage: 'failed', reason: PRODUCTION_TOOLS_MISSING_REASON }]);
    expect((await withBusiness(B, (db) => loadJob(db, jobId)))?.phase).toBe('failed');
  });

  it('spec-stage failed_checks has no version to show: versionId null', async () => {
    const { id } = await produce();
    const drafter = drafterOf([ungrounded()]);
    const r = run({ drafter: drafter.fn });
    expect(await r.promise).toMatchObject({ failedChecks: 1 });
    expect(drafter.calls).toHaveLength(3);
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.findings[0]).toMatchObject({ check: 'spec', code: 'ungrounded_number' });
    expect(r.finished).toEqual([{ productionId: id, versionId: null, stage: 'failed_checks', reason: null }]);
  });

  it('failed_checks after two built versions and a spec failure: the stale version is NOT passed', async () => {
    const { id } = await produce();
    const r = run({ drafter: drafterOf([letter(BAD_TITLE), letter(BAD_TITLE), ungrounded()]).fn });
    expect(await r.promise).toMatchObject({ failedChecks: 1 });
    expect((await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id)))?.versionNo).toBe(2);
    expect(r.finished[0]).toMatchObject({ stage: 'failed_checks', versionId: null });
  });

  it('failed after a version was built: versionId null', async () => {
    const { id } = await produce();
    const judge: DocJudge = async () => {
      throw new Error('sdk down');
    };
    const r = run({ drafter: drafterOf([letter()]).fn, judge });
    expect(await r.promise).toMatchObject({ failed: 1 });
    expect((await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id)))?.versionNo).toBe(1);
    expect(r.finished[0]).toMatchObject({ stage: 'failed', versionId: null, reason: 'הבדיקה השנייה של המסמך נכשלה' });
  });

  it('a built file missing from disk on resume ends failed with the file-changed reason', async () => {
    const { id } = await produce();
    const drafter = drafterOf([letter()]);
    await run({ drafter: drafter.fn, checkpoint: crashAt('version_saved') }).promise;
    const v = await withBusiness(TEST_BUSINESS, (db) => latestVersion(db, id));
    await rm(join(root, v!.storedPath));
    const result = await run({ drafter: drafter.fn }).promise;
    expect(result).toMatchObject({ failed: 1, errored: [] });
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.work.reason).toBe(FILE_CHANGED_REASON);
  });

  it('invariant breaks end failed with render_failed, never an endless errored', async () => {
    const noDraft = await produce();
    await testDb().query(`UPDATE document_productions SET stage = 'building', work = $2 WHERE production_id = $1`, [
      noDraft.id,
      { ...EMPTY_WORK, drafted: true, memoryIds: [] },
    ]);
    const noVersion = await produce();
    await testDb().query(`UPDATE document_productions SET stage = 'check1', work = $2 WHERE production_id = $1`, [
      noVersion.id,
      { ...EMPTY_WORK, drafted: true, memoryIds: [] },
    ]);
    const result = await run({ drafter: drafterOf([letter()]).fn }).promise;
    expect(result).toMatchObject({ failed: 2, errored: [] });
    for (const id of [noDraft.id, noVersion.id]) {
      const p = await withBusiness(B, (db) => loadProduction(db, id));
      expect(p?.stage).toBe('failed');
      expect(p?.work.reason).toBe(RENDER_ERROR_HE.render_failed);
    }
  });

  it('a vanished origin job is reported and the production still terminates', async () => {
    const { id } = await produce({ originJobId: 'J-gone' });
    const r = run({ drafter: drafterOf([letter()]).fn });
    expect(await r.promise).toMatchObject({ ready: 1, errored: [], originJobMissing: [id] });
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.work.finished).toBe(true);
    expect(r.finished).toHaveLength(1);
    // Next pass: nothing left to finish.
    expect(await run({ drafter: drafterOf([letter()]).fn }).promise).toMatchObject({
      ready: 0,
      errored: [],
      originJobMissing: [],
    });
  });

  it('the drafter and the judge receive the deadline signal, and it aborts on timeout', async () => {
    await produce();
    let seen: AbortSignal | undefined;
    const hang: Drafter = async (_request, signal) => {
      seen = signal;
      return new Promise(() => {});
    };
    await run({ drafter: hang, deadlines: { draft: 20 } }).promise;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);

    await produce();
    let judgeSignal: AbortSignal | undefined;
    const judge: DocJudge = async (request, signal) => {
      judgeSignal = signal;
      return passingJudge(request);
    };
    await run({ drafter: drafterOf([letter()]).fn, judge }).promise;
    expect(judgeSignal).toBeInstanceOf(AbortSignal);
    expect(judgeSignal!.aborted).toBe(false);
  });

  it('a stage whose deadlines exceed the remaining budget is not started (after the first)', async () => {
    const { id } = await produce();
    let t = 0;
    const drafter = drafterOf([letter()]);
    const slow: Drafter = async (request) => {
      t += 50_000; // 70s left: enough for the render (60s), not for the page render (90s)
      return drafter.fn(request);
    };
    const r = run({ drafter: slow, clock: () => t, budgetMs: 120_000 });
    await r.promise;
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.stage).toBe('check1');
    expect(r.renderer.calls).toHaveLength(0);
  });

  it('a stored check 1 is reused on resume: check 1 does not run again, pages re-rendered once for check 2', async () => {
    const { id } = await produce();
    let checks = 0;
    const check1 = async (input: Check1Input) => {
      checks += 1;
      return runCheck1(input);
    };
    await run({ drafter: drafterOf([letter()]).fn, check1, checkpoint: crashAt('check1_saved') }).promise;
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.stage).toBe('check1');
    const second = run({ drafter: drafterOf([letter()]).fn, check1 });
    expect(await second.promise).toMatchObject({ ready: 1 });
    expect(checks).toBe(1);
    expect(second.renderer.calls).toHaveLength(1);
  });

  it('a stored check 2 is reused on resume: the judge is not paid twice', async () => {
    const { id } = await produce();
    let judged = 0;
    const judge: DocJudge = async (request) => {
      judged += 1;
      return passingJudge(request);
    };
    await run({ drafter: drafterOf([letter()]).fn, judge, checkpoint: crashAt('check2_saved') }).promise;
    expect((await withBusiness(B, (db) => loadProduction(db, id)))?.stage).toBe('check2');
    const second = run({ drafter: drafterOf([letter()]).fn, judge });
    expect(await second.promise).toMatchObject({ ready: 1 });
    expect(judged).toBe(1);
    expect(second.renderer.calls).toHaveLength(0);
  });
});
