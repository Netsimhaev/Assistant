/**
 * The production loop (spec §5.5): draft → validate → build → check 1 →
 * check 2 → fix, each stage's output persisted before the stage moves, so a
 * crash resumes at the stored stage instead of paying again for a call that
 * already finished.
 *
 * **Stages.** `queued → drafting → building → check1 → check2 → ready`. A
 * failed `validateSpec`, check 1 or check 2 goes to `fixing` with
 * `attempt + 1` and the failing spec and findings in `work.previous`, then
 * back to `drafting`. A failure when two fixes were already spent
 * (`attempt === MAX_FIX_ATTEMPTS`) ends `failed_checks` — `attempt` stays 2,
 * so the daily cap counts only draft calls that happened. `failed` is for an
 * `undrafted` draft, any throw from a renderer or the judge, any timeout,
 * and the daily cap.
 *
 * **What a stage persists.** `queued → drafting` fixes the memory ids the
 * drafter will see (`work.memoryIds`); `drafting → building` stores the spec
 * `validateSpec` accepted (`work.draft`); `building` writes the file and its
 * `document_versions` row, whose id is deterministic per version number, so
 * a crash between the write and the stage move re-uses the row (no second
 * render); `check1`/`check2` store their results on the version. A crash
 * DURING a model call re-runs it — the one call that was not finished.
 *
 * **Grounding is against what the drafter saw.** The sources are the
 * production's own `source_document_ids` (this business only), the
 * instruction text, and the memory rows in `work.memoryIds`, read by id —
 * retired or not — so a resumed check grounds against the same set the
 * draft was written from.
 *
 * **A pdf's HTML is re-derived, not persisted** (controller ruling, T9
 * carry): `renderHtml` is deterministic given the spec and the assets, and
 * `renderPdfWithHtml` prints exactly `renderHtml(spec, assets, {currency})`.
 * Check 1 calls the same function on the stored spec with assets loaded the
 * same way. Persisting it was rejected: the HTML carries every font and image
 * as a `data:` URL (megabytes per version). The cost: a font file or image
 * changed on disk between build and check makes check 1 compare against HTML
 * the PDF was not printed from — it would fail (a fix round), never pass a
 * wrong file.
 *
 * **Check 2's page sample.** A check 1 that passes has no findings, so the
 * pages "check 1 flagged" are those its EARLIER failing runs on this
 * production flagged (`slide N` / `page N`) — where the fix landed.
 *
 * **The daily cap** (`config.documentsPerDay`) is checked before every draft
 * call is started: at `queued`, and before a fix round. Over it, the
 * production ends `failed` with `productionCapReason` and the drafter never
 * runs. `productionsToday` (`store.ts`) says what is counted.
 *
 * **Terminal side effects** — the origin job (`followup → closed` on ready /
 * failed_checks, `followup → failed` on failed, `PhaseMovedError` a skip),
 * the `document_production` audit row, and `onFinished` (ruling R4: the card
 * and the owner's notice are Task 14's, wired through this callback) — run
 * right after the terminal move, then `work.finished` is set. A crash in
 * between is picked up by `claimUnfinished` next pass: at least once, so the
 * audit row or the callback can repeat, never vanish.
 *
 * **Every external call is raced against a deadline** (`withDeadline`):
 * draft 180s, render 60s, page render 90s, judge 120s. A deadline that fires
 * aborts the signal handed to the call and ends the production `failed`.
 *
 * **Budget.** A pass stops starting stages once `budgetMs` has elapsed; the
 * production in hand keeps its stage and the rest stay where they are.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadActiveCharter, type ActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { getPool, type Queryable } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { renderArtifactFull } from '../documents/brief.js';
import { loadArtifacts } from '../documents/store.js';
import { DocumentSpec, type PdfSpec } from '../domain/document-spec.js';
import { productionStageLabel } from '../domain/labels.js';
import type { TrustLevel } from '../domain/trust.js';
import { withDeadline } from '../governance/notify.js';
import { recallMemories } from '../memory/store.js';
import { PhaseMovedError, transition } from '../orchestrator/jobs.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { MAX_MEMORIES, type DraftMemory, type Drafter, type FencedSource } from '../sdk/doc-drafter.js';
import { DOC_JUDGE_REQUIRED_CRITERIA, type DocJudge } from '../sdk/doc-judge.js';
import { canonicalHash } from '../util/canonical.js';
import { localParts } from '../util/local-time.js';
import { runCheck1, type Check1Finding, type Check1Result } from './check1.js';
import type { PageImages, PageRenderer } from './page-images.js';
import { createDbImageLoader, renderDocx } from './render-docx.js';
import { renderErrorReason, RENDER_ERROR_HE } from './render-error.js';
import { renderHtml, type PdfAssets } from './render-html.js';
import { loadPdfAssets, renderPdfWithHtml, type PdfPrinter } from './render-pdf.js';
import { renderPptx } from './render-pptx.js';
import type { ImageLoader } from './render-shared.js';
import { renderXlsx } from './render-xlsx.js';
import {
  advanceStage,
  claimProduction,
  claimUnfinished,
  latestVersion,
  loadProduction,
  productionsToday,
  releaseLease,
  saveVersion,
  saveVersionCheck,
  saveWork,
  versionIdFor,
  type DocumentVersion,
  type Production,
  type ProductionFinding,
  type ProductionWork,
} from './store.js';
import type { GroundingSources, SpecProblem, SpecProblemCode } from './validate-spec.js';
import { validateSpec } from './validate-spec.js';
import type { ProductionStage } from '../domain/document-spec.js';

/** Two fix rounds after the first draft (spec §7.3). */
export const MAX_FIX_ATTEMPTS = 2;

export const STAGE_DEADLINES_MS = { draft: 180_000, render: 60_000, pageRender: 90_000, judge: 120_000 } as const;
export type StageDeadlines = { [K in keyof typeof STAGE_DEADLINES_MS]: number };

export const DEFAULT_BUDGET_MS = 120_000;
/** Longer than the longest single call (draft, 180s) with room for the stages around it. */
export const PRODUCTION_LEASE_MS = 10 * 60_000;

const EXT: Record<DocumentSpec['format'], string> = { xlsx: 'xlsx', docx: 'docx', pptx: 'pptx', pdf: 'pdf' };

// ---------------------------------------------------------------- owner-facing reasons

export function productionCapReason(cap: number): string {
  return `הגעתי לתקרת המסמכים היומית (${cap}) — אפשר לבקש שוב מחר`;
}
export const DRAFT_UNDRAFTED_REASON = 'לא הצלחתי לנסח את המסמך מהבקשה ומהמקורות';
export const DRAFT_FAILED_REASON = 'ניסוח המסמך נכשל';
export const JUDGE_FAILED_REASON = 'הבדיקה השנייה של המסמך נכשלה';
export const FILE_CHANGED_REASON = 'הקובץ שנבנה השתנה בדיסק לפני שנבדק';

const TIMEOUT_REASON: Record<keyof typeof STAGE_DEADLINES_MS, string> = {
  draft: 'ניסוח המסמך לא הסתיים בזמן',
  render: RENDER_ERROR_HE.render_timeout,
  pageRender: RENDER_ERROR_HE.render_timeout,
  judge: 'הבדיקה השנייה של המסמך לא הסתיימה בזמן',
};

/** Fixed Hebrew per `validateSpec` code. Exhaustive. */
export const SPEC_PROBLEM_HE: Readonly<Record<SpecProblemCode, string>> = Object.freeze({
  formula_problem: 'נוסחה שאי אפשר לאמת שהיא מחושבת כמו ב-Excel',
  ungrounded_number: 'מספר או תאריך שאין לו מקור',
  source_not_found: 'הפניה למקור שלא קיים',
  cap_exceeded: 'המסמך ארוך מהמותר',
  missing_structure: 'חסר חלק חובה של סוג המסמך',
  unknown_image: 'הפניה לתמונה שלא נמצאה במקורות',
  filename_invalid: 'שם הקובץ אינו תקין',
});

const CHECK2_HE: Readonly<Record<(typeof DOC_JUDGE_REQUIRED_CRITERIA)[number], string>> = Object.freeze({
  answers_request: 'הבדיקה השנייה: המסמך אינו עונה על הבקשה',
  language_correct: 'הבדיקה השנייה: יש בעיות שפה',
  order_as_seen: 'הבדיקה השנייה: מילים או ספרות מוצגות בסדר הפוך',
  structure_fits_kind: 'הבדיקה השנייה: המבנה אינו מתאים לסוג המסמך',
  legible_professional: 'הבדיקה השנייה: העיצוב אינו קריא או חתוך',
});
const CHECK2_OTHER_HE = 'הבדיקה השנייה מצאה בעיה במסמך';
export const CHECK2_UNJUDGED_HE = 'הבדיקה השנייה לא הושלמה, ולכן המסמך לא אושר';

// ---------------------------------------------------------------- options and result

export interface ProductionFinished {
  productionId: string;
  versionId: string | null;
  stage: 'ready' | 'failed_checks' | 'failed';
  /** The Hebrew reason for `failed`; null otherwise. */
  reason: string | null;
}

export interface RunProductionsOptions {
  businessId?: string;
  /** Fixed instant for "today" and the cap's local midnight (tests). */
  now?: Date;
  budgetMs?: number;
  /** Elapsed-time clock for the budget. Test seam. */
  clock?: () => number;
  /** The runtime's production tools. Absent or unavailable, and no injected seams: the loop does not run. */
  production?: Runtime['production'];
  drafter?: Drafter;
  judge?: DocJudge;
  printer?: PdfPrinter;
  renderer?: PageRenderer;
  /** Test seams; production uses the defaults. */
  check1?: typeof runCheck1;
  pdfAssets?: (spec: PdfSpec) => Promise<PdfAssets>;
  images?: ImageLoader;
  /** Ruling R4: Task 14 creates the card and notifies here. */
  onFinished?: (finished: ProductionFinished) => Promise<void>;
  documentRoot?: string;
  perDay?: number;
  holder?: string;
  leaseMs?: number;
  deadlines?: Partial<StageDeadlines>;
  /** Test seam: a throw here simulates a crash at that point. */
  checkpoint?: (event: 'version_saved', productionId: string) => Promise<void> | void;
  db?: Queryable;
}

export interface RunProductionsResult {
  /** Stage moves made this pass. */
  advanced: number;
  ready: number;
  failedChecks: number;
  failed: number;
  /** Lost races: a stage someone else moved, an origin job someone else moved. */
  skipped: number;
  errored: { productionId: string; error: string }[];
}

class StageTimeout extends Error {
  constructor(readonly stage: keyof typeof STAGE_DEADLINES_MS) {
    super(`${stage} deadline`);
    this.name = 'StageTimeout';
  }
}
class Inner {
  constructor(readonly error: unknown) {}
}

/** `withDeadline`, telling a deadline that fired apart from the call's own rejection. */
async function timed<T>(
  stage: keyof typeof STAGE_DEADLINES_MS,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const wrapped = run(controller.signal).catch((err: unknown) => {
    throw new Inner(err);
  });
  try {
    return await withDeadline(wrapped, ms, stage);
  } catch (err) {
    if (err instanceof Inner) throw err.error;
    controller.abort();
    throw new StageTimeout(stage);
  }
}

// ---------------------------------------------------------------- sources

/**
 * Documents have no trust column; every attached document is fenced as
 * `unknown_external` until an upload path records the owner as its author
 * (spec §5.6, Task 15). Over-fencing the owner's own file costs nothing.
 */
function documentProvenance(_source: string): TrustLevel {
  return 'unknown_external';
}

/** A memory body as text — the SAME string the drafter sees and grounding checks. */
export function memoryText(body: Record<string, unknown>): string {
  return Object.entries(body)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

interface LoadedSources {
  fenced: FencedSource[];
  memories: DraftMemory[];
  grounding: GroundingSources;
}

async function loadSources(p: Production, memoryIds: readonly string[], db: Queryable): Promise<LoadedSources> {
  const fenced: FencedSource[] = [];
  if (p.sourceDocumentIds.length > 0) {
    const { rows } = await db.query<{ document_id: string; source: string }>(
      `SELECT document_id, source FROM documents WHERE business_id = $1 AND document_id = ANY($2::text[])
        ORDER BY array_position($2::text[], document_id)`,
      [p.businessId, p.sourceDocumentIds],
    );
    for (const row of rows) {
      const artifacts = await loadArtifacts(row.document_id, { businessId: p.businessId, db });
      fenced.push({
        documentId: row.document_id,
        provenance: documentProvenance(row.source),
        artifacts: artifacts.map((a) => ({ ordinal: a.ordinal, text: renderArtifactFull(a) })),
      });
    }
  }
  const memories: DraftMemory[] = [];
  if (memoryIds.length > 0) {
    const { rows } = await db.query<{ memory_id: string; body: Record<string, unknown>; provenance: TrustLevel }>(
      `SELECT memory_id, body, provenance FROM memories
        WHERE business_id = $1 AND memory_id = ANY($2::text[])
        ORDER BY array_position($2::text[], memory_id)`,
      [p.businessId, [...memoryIds]],
    );
    for (const row of rows) memories.push({ memoryId: row.memory_id, body: memoryText(row.body), provenance: row.provenance });
  }
  return {
    fenced,
    memories,
    grounding: {
      instructionText: p.instructionText,
      documents: fenced.map((d) => ({ documentId: d.documentId, artifacts: d.artifacts })),
      memories: memories.map((m) => ({ memoryId: m.memoryId, body: m.body })),
    },
  };
}

/** Positive scope: memories about the people this production is addressed to, nothing else. */
async function recallFor(p: Production, db: Queryable): Promise<string[]> {
  if (p.destination.mode !== 'send') return [];
  const ids: string[] = [];
  for (const to of p.destination.to) {
    for (const m of await recallMemories({ subjectKey: to.toLowerCase(), limit: 20 }, { businessId: p.businessId, db })) {
      if (!ids.includes(m.memoryId)) ids.push(m.memoryId);
    }
  }
  return ids.slice(0, MAX_MEMORIES);
}

// ---------------------------------------------------------------- findings

function specFindings(problems: readonly SpecProblem[]): ProductionFinding[] {
  return problems.map((p) => ({ check: 'spec', code: p.code, where: p.where, he: SPEC_PROBLEM_HE[p.code], detail: p.detail }));
}

function check1Findings(findings: readonly Check1Finding[]): ProductionFinding[] {
  return findings.map((f) => ({ check: 'check1', code: f.code, where: f.where, he: f.he }));
}

/** What the next drafter reads (fenced as findings): the fixed text, where, and any detail. */
function forDrafter(findings: readonly ProductionFinding[]): { he: string }[] {
  return findings.map((f) => ({ he: `${f.he} — ${f.where}${f.detail === undefined ? '' : `: ${f.detail}`}` }));
}

/** `slide N` / `page N` positions check 1 names, as 1-based page numbers. */
export function flaggedPagesOf(findings: readonly { where: string }[]): number[] {
  const pages = new Set<number>();
  for (const f of findings) {
    const m = /^(?:slide|page) (\d+)\b/.exec(f.where);
    if (m) pages.add(Number(m[1]));
  }
  return [...pages].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- the loop

interface Ctx {
  businessId: string;
  db: Queryable;
  active: ActiveCharter;
  currency: string;
  drafter: Drafter;
  judge: DocJudge;
  printer: PdfPrinter;
  renderer: PageRenderer;
  check1: typeof runCheck1;
  pdfAssets: (spec: PdfSpec) => Promise<PdfAssets>;
  images: ImageLoader;
  onFinished: (finished: ProductionFinished) => Promise<void>;
  documentRoot: string;
  perDay: number;
  deadlines: StageDeadlines;
  checkpoint: NonNullable<RunProductionsOptions['checkpoint']>;
  today: () => string;
  now: () => Date;
  result: RunProductionsResult;
}

type StepOutcome = 'moved' | 'lost';

async function move(
  ctx: Ctx,
  p: Production,
  to: ProductionStage,
  work: ProductionWork,
  attempt?: number,
): Promise<StepOutcome> {
  const ok = await advanceStage(p.productionId, p.stage, to, { work, ...(attempt === undefined ? {} : { attempt }) }, ctx.db);
  if (!ok) return 'lost';
  ctx.result.advanced += 1;
  return 'moved';
}

async function fail(ctx: Ctx, p: Production, reason: string, work: ProductionWork = p.work): Promise<StepOutcome> {
  return move(ctx, p, 'failed', { ...work, reason });
}

async function capReached(ctx: Ctx): Promise<boolean> {
  const used = await productionsToday(ctx.businessId, ctx.active.charter.identity.timezone, ctx.db, ctx.now());
  return used >= ctx.perDay;
}

/** A failed attempt: another fix round, or `failed_checks` when both are spent. */
async function failAttempt(
  ctx: Ctx,
  p: Production,
  spec: DocumentSpec,
  findings: ProductionFinding[],
): Promise<StepOutcome> {
  const base: ProductionWork = { ...p.work, draft: null, findings };
  if (p.attempt >= MAX_FIX_ATTEMPTS) return move(ctx, p, 'failed_checks', base);
  if (await capReached(ctx)) return fail(ctx, p, productionCapReason(ctx.perDay), base);
  return move(ctx, p, 'fixing', { ...base, previous: { spec, findings: forDrafter(findings) } }, p.attempt + 1);
}

async function stepQueued(ctx: Ctx, p: Production): Promise<StepOutcome> {
  if (await capReached(ctx)) return fail(ctx, p, productionCapReason(ctx.perDay));
  const memoryIds = p.work.memoryIds ?? (await recallFor(p, ctx.db));
  return move(ctx, p, 'drafting', { ...p.work, drafted: true, memoryIds });
}

async function stepDrafting(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const sources = await loadSources(p, p.work.memoryIds ?? [], ctx.db);
  const today = ctx.today();
  const previousSpec = p.work.previous === null ? null : DocumentSpec.safeParse(p.work.previous.spec);
  let outcome: Awaited<ReturnType<Drafter>>;
  try {
    outcome = await timed('draft', ctx.deadlines.draft, () =>
      ctx.drafter({
        bundle: ctx.active.bundle,
        instruction: p.instructionText,
        format: p.format,
        language: p.language,
        kind: p.kind,
        sources: sources.fenced,
        memories: sources.memories,
        today,
        ...(previousSpec?.success === true && p.work.previous !== null
          ? { previous: { spec: previousSpec.data, findings: p.work.previous.findings } }
          : {}),
      }),
    );
  } catch (err) {
    return fail(ctx, p, err instanceof StageTimeout ? TIMEOUT_REASON.draft : DRAFT_FAILED_REASON);
  }
  if (outcome.status === 'undrafted') return fail(ctx, p, DRAFT_UNDRAFTED_REASON);
  const spec = outcome.spec;
  if (spec.format !== p.format || spec.kind !== p.kind || spec.language !== p.language) {
    return fail(ctx, p, DRAFT_UNDRAFTED_REASON);
  }
  const problems = validateSpec(spec, sources.grounding, { today });
  if (problems.length > 0) return failAttempt(ctx, p, spec, specFindings(problems));
  return move(ctx, p, 'building', { ...p.work, draft: spec, findings: [] });
}

function relativeFilePath(p: Production, versionId: string, ext: string): string {
  return join('produced', p.businessId, p.productionId, `${versionId}.${ext}`);
}

async function stepBuilding(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const versionNo = p.attempt + 1;
  const existing = await latestVersion(p.productionId, ctx.db);
  if (existing?.versionNo === versionNo) return move(ctx, p, 'check1', { ...p.work, draft: null });

  const parsed = DocumentSpec.safeParse(p.work.draft);
  if (!parsed.success) throw new Error(`production ${p.productionId} is in building with no stored draft`);
  const spec = parsed.data;
  let bytes: Buffer;
  try {
    bytes = await timed('render', ctx.deadlines.render, async () => {
      switch (spec.format) {
        case 'xlsx':
          return renderXlsx(spec, { currency: ctx.currency });
        case 'docx':
          return renderDocx(spec, { currency: ctx.currency, images: ctx.images });
        case 'pptx':
          return (await renderPptx(spec, { currency: ctx.currency, images: ctx.images })).buffer;
        case 'pdf': {
          const assets = await ctx.pdfAssets(spec);
          return (await renderPdfWithHtml(spec, { printer: ctx.printer, assets, currency: ctx.currency })).pdf;
        }
      }
    });
  } catch (err) {
    return fail(ctx, p, err instanceof StageTimeout ? TIMEOUT_REASON.render : renderErrorReason(err));
  }

  const versionId = versionIdFor(p.productionId, versionNo);
  const storedPath = relativeFilePath(p, versionId, EXT[spec.format]);
  const full = join(ctx.documentRoot, storedPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);
  await saveVersion(
    {
      productionId: p.productionId,
      versionNo,
      spec,
      storedPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
    ctx.db,
  );
  await ctx.checkpoint('version_saved', p.productionId);
  return move(ctx, p, 'check1', { ...p.work, draft: null });
}

async function currentVersion(ctx: Ctx, p: Production): Promise<{ version: DocumentVersion; bytes: Buffer } | null> {
  const version = await latestVersion(p.productionId, ctx.db);
  if (version === null || version.versionNo !== p.attempt + 1) {
    throw new Error(`production ${p.productionId} is in ${p.stage} with no version ${p.attempt + 1}`);
  }
  const bytes = await readFile(join(ctx.documentRoot, version.storedPath));
  if (createHash('sha256').update(bytes).digest('hex') !== version.sha256) return null;
  return { version, bytes };
}

async function renderPages(
  ctx: Ctx,
  file: { format: DocumentSpec['format']; bytes: Buffer },
  flaggedPages: readonly number[],
): Promise<PageImages | { failed: string }> {
  try {
    return await timed('pageRender', ctx.deadlines.pageRender, (signal) =>
      ctx.renderer(file, signal, flaggedPages.length > 0 ? { flaggedPages } : {}),
    );
  } catch (err) {
    return { failed: err instanceof StageTimeout ? TIMEOUT_REASON.pageRender : renderErrorReason(err) };
  }
}

async function stepCheck1(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const current = await currentVersion(ctx, p);
  if (current === null) return fail(ctx, p, FILE_CHANGED_REASON);
  const { version, bytes } = current;
  const spec = version.spec;
  const sources = await loadSources(p, p.work.memoryIds ?? [], ctx.db);
  const today = ctx.today();

  const pages = await renderPages(ctx, { format: spec.format, bytes }, []);
  if ('failed' in pages) return fail(ctx, p, pages.failed);
  const rendered = { text: pages.text, pageCount: pages.pageCount, textTruncated: pages.textTruncated };

  let result: Check1Result;
  if (spec.format === 'pdf') {
    // Re-derived: the same `renderHtml` call `renderPdfWithHtml` printed.
    const html = renderHtml(spec, await ctx.pdfAssets(spec), { currency: ctx.currency });
    result = await ctx.check1({ spec, bytes, sources: sources.grounding, rendered, today, currency: ctx.currency, html });
  } else {
    result = await ctx.check1({ spec, bytes, sources: sources.grounding, rendered, today, currency: ctx.currency });
  }
  const findings = check1Findings(result.findings);
  await saveVersionCheck(
    version.versionId,
    'check1',
    { passed: result.passed, findings: result.findings, pageCount: pages.pageCount, flaggedPages: flaggedPagesOf(result.findings) },
    ctx.db,
  );
  if (!result.passed) return failAttempt(ctx, p, spec, findings);
  return move(ctx, p, 'check2', { ...p.work, findings: [] });
}

async function flaggedSoFar(ctx: Ctx, productionId: string): Promise<number[]> {
  const { rows } = await ctx.db.query<{ check1: { flaggedPages?: number[] } | null }>(
    'SELECT check1 FROM document_versions WHERE production_id = $1',
    [productionId],
  );
  const pages = new Set<number>();
  for (const r of rows) for (const n of r.check1?.flaggedPages ?? []) if (Number.isInteger(n)) pages.add(n);
  return [...pages].sort((a, b) => a - b);
}

async function stepCheck2(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const current = await currentVersion(ctx, p);
  if (current === null) return fail(ctx, p, FILE_CHANGED_REASON);
  const { version, bytes } = current;
  const spec = version.spec;

  const pages = await renderPages(ctx, { format: spec.format, bytes }, await flaggedSoFar(ctx, p.productionId));
  if ('failed' in pages) return fail(ctx, p, pages.failed);

  let outcome: Awaited<ReturnType<DocJudge>>;
  try {
    outcome = await timed('judge', ctx.deadlines.judge, () =>
      ctx.judge({
        bundle: ctx.active.bundle,
        instruction: p.instructionText,
        kind: p.kind,
        language: p.language,
        text: pages.text,
        pages: pages.pages,
      }),
    );
  } catch (err) {
    return fail(ctx, p, err instanceof StageTimeout ? TIMEOUT_REASON.judge : JUDGE_FAILED_REASON);
  }

  // The card's preview: check 2's first page, stored beside the version.
  let previewPath: string | null = null;
  const first = pages.pages[0];
  if (first !== undefined) {
    previewPath = relativeFilePath(p, version.versionId, 'preview.png');
    await writeFile(join(ctx.documentRoot, previewPath), first);
  }

  let findings: ProductionFinding[];
  if (outcome.status === 'unjudged') {
    findings = [{ check: 'check2', code: 'unjudged', where: 'document', he: CHECK2_UNJUDGED_HE }];
  } else {
    findings = outcome.criteria
      .filter((c) => !c.passed && c.severity === 'must')
      .map((c) => ({
        check: 'check2' as const,
        code: c.id,
        where: 'document',
        he: Object.hasOwn(CHECK2_HE, c.id) ? CHECK2_HE[c.id as keyof typeof CHECK2_HE] : CHECK2_OTHER_HE,
        detail: c.detail,
      }));
  }
  const passed = outcome.status === 'judged' && findings.length === 0;
  await saveVersionCheck(
    version.versionId,
    'check2',
    {
      passed,
      status: outcome.status,
      criteria: outcome.status === 'judged' ? outcome.criteria : [],
      pageCount: pages.pageCount,
      previewPath,
    },
    ctx.db,
  );
  if (!passed) return failAttempt(ctx, p, spec, findings);
  return move(ctx, p, 'ready', { ...p.work, findings: [] });
}

async function step(ctx: Ctx, p: Production): Promise<StepOutcome> {
  switch (p.stage) {
    case 'queued':
      return stepQueued(ctx, p);
    case 'drafting':
      return stepDrafting(ctx, p);
    case 'building':
      return stepBuilding(ctx, p);
    case 'check1':
      return stepCheck1(ctx, p);
    case 'check2':
      return stepCheck2(ctx, p);
    case 'fixing':
      return move(ctx, p, 'drafting', p.work);
    case 'ready':
    case 'failed_checks':
    case 'failed':
      throw new Error(`step called on terminal stage ${p.stage}`);
  }
}

async function reload(ctx: Ctx, productionId: string): Promise<Production> {
  const p = await loadProduction(ctx.businessId, productionId, ctx.db);
  if (p === null) throw new Error(`production ${productionId} vanished`);
  return p;
}

const isTerminal = (stage: ProductionStage): stage is ProductionFinished['stage'] =>
  stage === 'ready' || stage === 'failed_checks' || stage === 'failed';

/** Origin job, audit row, callback — then `finished`. At least once. */
async function finish(ctx: Ctx, p: Production): Promise<void> {
  if (!isTerminal(p.stage) || p.work.finished) return;
  const stage = p.stage;
  const version = await latestVersion(p.productionId, ctx.db);
  const reason = stage === 'failed' ? (p.work.reason ?? RENDER_ERROR_HE.render_failed) : null;

  try {
    await transition(p.originJobId, {
      to: stage === 'failed' ? 'failed' : 'closed',
      expectFrom: 'followup',
      actor: 'orchestrator',
      reason: stage === 'failed' ? `הפקת המסמך נכשלה: ${reason}` : `הפקת המסמך הסתיימה: ${productionStageLabel[stage]}`,
      businessId: p.businessId,
    });
  } catch (err) {
    if (!(err instanceof PhaseMovedError)) throw err;
    ctx.result.skipped += 1;
  }

  await appendAudit(
    {
      actor: 'orchestrator',
      kind: 'document_production',
      jobId: p.originJobId,
      charterVersion: ctx.active.bundle.charterVersion,
      provenance: 'boss',
      // No content: the request can name a person (see AuditKind).
      inputHash: canonicalHash({ productionId: p.productionId, format: p.format, kind: p.kind, stage }),
      artifacts: [],
      costMinor: null,
      tokens: null,
      reason: `הפקת מסמך · ${productionStageLabel[stage]}`,
    },
    { businessId: p.businessId },
  );

  await ctx.onFinished({ productionId: p.productionId, versionId: version?.versionId ?? null, stage, reason });
  await saveWork(p.productionId, stage, { ...p.work, finished: true }, ctx.db);

  if (stage === 'ready') ctx.result.ready += 1;
  else if (stage === 'failed_checks') ctx.result.failedChecks += 1;
  else ctx.result.failed += 1;
}

/**
 * Advance one production until it is terminal, a race is lost, or the budget
 * runs out. Returns false when the budget ran out (the pass should stop).
 */
async function drive(ctx: Ctx, first: Production, hasBudget: () => boolean): Promise<boolean> {
  let p = first;
  while (!isTerminal(p.stage)) {
    if (!hasBudget()) return false;
    if ((await step(ctx, p)) === 'lost') {
      ctx.result.skipped += 1;
      return true;
    }
    p = await reload(ctx, p.productionId);
  }
  await finish(ctx, p);
  return true;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the loop for one business. `null` when production cannot run on this
 * server (`runtime.production` absent or unavailable, and no seams injected)
 * — "did not run", never zeros, which would read as "nothing to do".
 */
export async function runDocumentProductions(options: RunProductionsOptions = {}): Promise<RunProductionsResult | null> {
  const businessId = options.businessId ?? config.businessId;
  const db = options.db ?? getPool();
  const tools = options.production;
  const toolsUp = tools?.available === true && tools.sofficePath !== null && tools.chromiumPath !== null;

  let printer = options.printer ?? null;
  let renderer = options.renderer ?? null;
  if ((printer === null || renderer === null) && toolsUp) {
    // Loaded only when used: the scheduler must not pull Playwright in on an
    // installation that cannot produce documents.
    const [{ createChromiumPrinter }, { createLocalPageRenderer }] = await Promise.all([
      import('./chromium.js'),
      import('./page-images.js'),
    ]);
    printer ??= createChromiumPrinter({ executablePath: tools.chromiumPath! });
    renderer ??= createLocalPageRenderer({ sofficePath: tools.sofficePath!, chromiumPath: tools.chromiumPath! });
  }
  if (printer === null || renderer === null) return null;

  const active = await loadActiveCharter(businessId, db);
  if (active === null) throw new Error(`runDocumentProductions: no active charter for ${businessId}`);

  let drafter = options.drafter;
  let judge = options.judge;
  if (drafter === undefined) drafter = (await import('../sdk/doc-drafter.js')).draftDocumentSpec;
  if (judge === undefined) judge = (await import('../sdk/doc-judge.js')).judgeDocument;

  const images = options.images ?? createDbImageLoader(businessId, db);
  const now = (): Date => options.now ?? new Date();
  const result: RunProductionsResult = { advanced: 0, ready: 0, failedChecks: 0, failed: 0, skipped: 0, errored: [] };
  const ctx: Ctx = {
    businessId,
    db,
    active,
    currency: active.bundle.ceilings.currency,
    drafter,
    judge,
    printer,
    renderer,
    check1: options.check1 ?? runCheck1,
    pdfAssets: options.pdfAssets ?? ((spec) => loadPdfAssets(spec, { images })),
    images,
    onFinished: options.onFinished ?? (async () => {}),
    documentRoot: options.documentRoot ?? config.documentRoot,
    perDay: options.perDay ?? config.documentsPerDay,
    deadlines: { ...STAGE_DEADLINES_MS, ...options.deadlines },
    checkpoint: options.checkpoint ?? (() => {}),
    today: () => localParts(now(), active.charter.identity.timezone).date,
    now,
    result,
  };

  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const hasBudget = (): boolean => clock() - started < budgetMs;
  const holder = options.holder ?? `scheduler-${process.pid}`;
  const leaseMs = options.leaseMs ?? PRODUCTION_LEASE_MS;
  const attempted: string[] = [];

  // Stragglers first: terminal rows whose side effects a crash interrupted.
  while (hasBudget()) {
    const p = await claimUnfinished(businessId, holder, leaseMs, db, attempted);
    if (p === null) break;
    attempted.push(p.productionId);
    try {
      await finish(ctx, p);
    } catch (err) {
      result.errored.push({ productionId: p.productionId, error: errorText(err) });
    } finally {
      await releaseLease(p.productionId, holder, db);
    }
  }

  while (hasBudget()) {
    const p = await claimProduction(businessId, holder, leaseMs, db, attempted);
    if (p === null) break;
    attempted.push(p.productionId);
    let keepGoing = true;
    try {
      keepGoing = await drive(ctx, p, hasBudget);
    } catch (err) {
      result.errored.push({ productionId: p.productionId, error: errorText(err) });
    } finally {
      await releaseLease(p.productionId, holder, db);
    }
    if (!keepGoing) break;
  }
  return result;
}
