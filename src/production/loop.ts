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
 * render); `check1`/`check2` store their results on the version, and a
 * resumed stage that finds its result already stored uses it instead of
 * paying again. A crash DURING a model call re-runs it — the one call that
 * was not finished. The working record lives in the `work` column (054);
 * `findings` holds the last failing findings only.
 *
 * **One page render per attempt.** Check 1 renders the pages once (with the
 * pages earlier attempts flagged) and check 2 judges those same images in the
 * same drive; only a resume into `check2` renders again.
 *
 * **Deterministic failures terminate.** A built file missing or changed on
 * disk ends `failed` with `FILE_CHANGED_REASON`; a broken invariant (building
 * with no stored draft, a check with no version for this attempt) ends
 * `failed` with `render_failed` — never an `errored` that repeats each pass.
 * An origin job that no longer exists is reported (`originJobMissing`) and
 * the production still finishes.
 *
 * **Missing tools.** Without a printer and page renderer the pass returns
 * `null` ("did not run"), but every claimable non-terminal production ends
 * `failed` with `PRODUCTION_TOOLS_MISSING_REASON` and is finished (origin job
 * failed, `onFinished` called), so no request waits forever.
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
 * aborts the signal handed to the call — the drafter and the judge pass it to
 * the SDK as `abortController`, so the billed call stops too — and ends the
 * production `failed`.
 *
 * **Budget.** A stage starts only if the remaining budget covers that
 * stage's deadlines (`stageCostMs`: draft 180s, build 60s, check 1 90s,
 * check 2 210s, or 120s when check 1's pages are in hand); stages with no
 * external call cost 0. The FIRST costed stage of a pass is exempt — the
 * draft alone (180s) exceeds the default budget (120s), and without the
 * exemption nothing would ever be drafted. True upper bound on one pass:
 * `max(budgetMs, largest stage cost)` plus database time — 210s with the
 * defaults. The cost: a production usually needs two passes (draft, build
 * and check 1 in one; check 2 in the next).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadActiveCharter, type ActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import type { BusinessDb } from '../db/pool.js';
import { appendAudit } from '../audit/log.js';
import { renderArtifactFull } from '../documents/brief.js';
import { loadArtifacts } from '../documents/store.js';
import { DocumentSpec, type PdfSpec } from '../domain/document-spec.js';
import { productionStageLabel } from '../domain/labels.js';
import type { TrustLevel } from '../domain/trust.js';
import { withDeadline } from '../governance/notify.js';
import { recallMemories } from '../memory/store.js';
import { loadJob, PhaseMovedError, transition } from '../orchestrator/jobs.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { MAX_MEMORIES, type DraftMemory, type Drafter, type FencedSource } from '../sdk/doc-drafter.js';
import { DOC_JUDGE_REQUIRED_CRITERIA, type DocJudge } from '../sdk/doc-judge.js';
import { canonicalHash } from '../util/canonical.js';
import { localParts } from '../util/local-time.js';
import { runCheck1, type Check1Finding, type Check1Result } from './check1.js';
import type { PageImages, PageRenderer } from './page-images.js';
import { createDbImageLoader, renderDocx } from './render-docx.js';
import { PRODUCTION_TOOLS_MISSING_REASON, renderErrorReason, RENDER_ERROR_HE } from './render-error.js';
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
  sourceProvenance,
  versionIdFor,
  type DocumentVersion,
  type Production,
  ProductionFinding,
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
  checkpoint?: (event: CheckpointEvent, productionId: string) => Promise<void> | void;
}

export type CheckpointEvent = 'version_saved' | 'check1_saved' | 'check2_saved';

export interface RunProductionsResult {
  /** Stage moves made this pass. */
  advanced: number;
  ready: number;
  failedChecks: number;
  failed: number;
  /** Lost races: a stage someone else moved, an origin job someone else moved. */
  skipped: number;
  errored: { productionId: string; error: string }[];
  /** Productions that finished although their origin job no longer exists. */
  originJobMissing: string[];
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

// Defined beside the work record it reads (store.ts); re-exported for the loop's readers.
export { sourceProvenance };

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

async function loadSources(p: Production, memoryIds: readonly string[], db: BusinessDb): Promise<LoadedSources> {
  const fenced: FencedSource[] = [];
  if (p.sourceDocumentIds.length > 0) {
    const { rows } = await db.query<{ document_id: string }>(
      `SELECT document_id FROM documents WHERE business_id = $1 AND document_id = ANY($2::text[])
        ORDER BY array_position($2::text[], document_id)`,
      [db.businessId, p.sourceDocumentIds],
    );
    for (const row of rows) {
      const artifacts = await loadArtifacts(db, row.document_id);
      fenced.push({
        documentId: row.document_id,
        provenance: sourceProvenance(p, row.document_id),
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
      [db.businessId, [...memoryIds]],
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
async function recallFor(p: Production, db: BusinessDb): Promise<string[]> {
  if (p.destination.mode !== 'send') return [];
  const ids: string[] = [];
  for (const to of p.destination.to) {
    for (const m of await recallMemories(db, { subjectKey: to.toLowerCase(), limit: 20 })) {
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
  db: BusinessDb;
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
  /** Pages check 1 rendered this pass, by version id — check 2 judges the same images. */
  pages: Map<string, PageImages>;
}

type StepOutcome = 'moved' | 'lost';

interface MoveOptions {
  work?: ProductionWork;
  findings?: ProductionFinding[];
  attempt?: number;
}

async function move(ctx: Ctx, p: Production, to: ProductionStage, o: MoveOptions = {}): Promise<StepOutcome> {
  const ok = await advanceStage(
    ctx.db,
    p.productionId,
    p.stage,
    to,
    {
      work: o.work ?? p.work,
      ...(o.findings === undefined ? {} : { findings: o.findings }),
      ...(o.attempt === undefined ? {} : { attempt: o.attempt }),
    },
  );
  if (!ok) return 'lost';
  ctx.result.advanced += 1;
  return 'moved';
}

async function fail(ctx: Ctx, p: Production, reason: string, o: MoveOptions = {}): Promise<StepOutcome> {
  return move(ctx, p, 'failed', { ...o, work: { ...(o.work ?? p.work), reason } });
}

async function capReached(ctx: Ctx): Promise<boolean> {
  const used = await productionsToday(ctx.db, ctx.active.charter.identity.timezone, ctx.now());
  return used >= ctx.perDay;
}

/** A failed attempt: another fix round, or `failed_checks` when both are spent. */
async function failAttempt(
  ctx: Ctx,
  p: Production,
  spec: DocumentSpec,
  findings: ProductionFinding[],
): Promise<StepOutcome> {
  const work: ProductionWork = { ...p.work, draft: null };
  if (p.attempt >= MAX_FIX_ATTEMPTS) return move(ctx, p, 'failed_checks', { work, findings });
  if (await capReached(ctx)) return fail(ctx, p, productionCapReason(ctx.perDay), { work, findings });
  return move(ctx, p, 'fixing', {
    work: { ...work, previous: { spec, findings: forDrafter(findings) } },
    findings,
    attempt: p.attempt + 1,
  });
}

/** A broken invariant: deterministic, so it terminates the production instead of repeating as `errored`. */
class InvariantBroken extends Error {}

async function stepQueued(ctx: Ctx, p: Production): Promise<StepOutcome> {
  if (await capReached(ctx)) return fail(ctx, p, productionCapReason(ctx.perDay));
  const memoryIds = p.work.memoryIds ?? (await recallFor(p, ctx.db));
  return move(ctx, p, 'drafting', { work: { ...p.work, drafted: true, memoryIds } });
}

async function stepDrafting(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const sources = await loadSources(p, p.work.memoryIds ?? [], ctx.db);
  const today = ctx.today();
  const previousSpec = p.work.previous === null ? null : DocumentSpec.safeParse(p.work.previous.spec);
  let outcome: Awaited<ReturnType<Drafter>>;
  try {
    outcome = await timed('draft', ctx.deadlines.draft, (signal) =>
      ctx.drafter(
        {
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
        },
        signal,
      ),
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
  return move(ctx, p, 'building', { work: { ...p.work, draft: spec }, findings: [] });
}

function relativeFilePath(p: Production, versionId: string, ext: string): string {
  return join('produced', p.businessId, p.productionId, `${versionId}.${ext}`);
}

async function stepBuilding(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const versionNo = p.attempt + 1;
  const existing = await latestVersion(ctx.db, p.productionId);
  if (existing?.versionNo === versionNo) return move(ctx, p, 'check1', { work: { ...p.work, draft: null } });

  const parsed = DocumentSpec.safeParse(p.work.draft);
  if (!parsed.success) throw new InvariantBroken(`production ${p.productionId} is in building with no stored draft`);
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
    ctx.db,
    {
      productionId: p.productionId,
      versionNo,
      spec,
      storedPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  );
  await ctx.checkpoint('version_saved', p.productionId);
  return move(ctx, p, 'check1', { work: { ...p.work, draft: null } });
}

/** The version this attempt built — or an invariant break. */
async function attemptVersion(ctx: Ctx, p: Production): Promise<DocumentVersion> {
  const version = await latestVersion(ctx.db, p.productionId);
  if (version === null || version.versionNo !== p.attempt + 1) {
    throw new InvariantBroken(`production ${p.productionId} is in ${p.stage} with no version ${p.attempt + 1}`);
  }
  return version;
}

/** The file's bytes, or `null` when it is missing or no longer matches the version's sha256. */
async function versionBytes(ctx: Ctx, version: DocumentVersion): Promise<Buffer | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(ctx.documentRoot, version.storedPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return createHash('sha256').update(bytes).digest('hex') === version.sha256 ? bytes : null;
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

async function flaggedSoFar(ctx: Ctx, productionId: string): Promise<number[]> {
  const { rows } = await ctx.db.query<{ check1: { flaggedPages?: number[] } | null }>(
    'SELECT check1 FROM document_versions WHERE production_id = $1',
    [productionId],
  );
  const pages = new Set<number>();
  for (const r of rows) for (const n of r.check1?.flaggedPages ?? []) if (Number.isInteger(n)) pages.add(n);
  return [...pages].sort((a, b) => a - b);
}

const StoredCheck1 = z.object({
  passed: z.boolean(),
  findings: z.array(z.object({ code: z.string(), where: z.string(), he: z.string() })),
});
const StoredCheck2 = z.object({ passed: z.boolean(), findings: z.array(ProductionFinding) });

async function stepCheck1(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const version = await attemptVersion(ctx, p);
  const spec = version.spec;

  // Resumed after the result was stored: use it, do not pay again.
  const stored = StoredCheck1.safeParse(version.check1);
  if (stored.success) {
    if (!stored.data.passed) return failAttempt(ctx, p, spec, check1Findings(stored.data.findings as Check1Finding[]));
    return move(ctx, p, 'check2', { findings: [] });
  }

  const bytes = await versionBytes(ctx, version);
  if (bytes === null) return fail(ctx, p, FILE_CHANGED_REASON);
  const sources = await loadSources(p, p.work.memoryIds ?? [], ctx.db);
  const today = ctx.today();

  // Rendered once for this attempt: check 1 reads the text, check 2 the images.
  const pages = await renderPages(ctx, { format: spec.format, bytes }, await flaggedSoFar(ctx, p.productionId));
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
  await saveVersionCheck(
    ctx.db,
    version.versionId,
    'check1',
    { passed: result.passed, findings: result.findings, pageCount: pages.pageCount, flaggedPages: flaggedPagesOf(result.findings) },
  );
  await ctx.checkpoint('check1_saved', p.productionId);
  if (!result.passed) return failAttempt(ctx, p, spec, check1Findings(result.findings));
  ctx.pages.set(version.versionId, pages);
  return move(ctx, p, 'check2', { findings: [] });
}

async function stepCheck2(ctx: Ctx, p: Production): Promise<StepOutcome> {
  const version = await attemptVersion(ctx, p);
  const spec = version.spec;

  const stored = StoredCheck2.safeParse(version.check2);
  if (stored.success) {
    if (!stored.data.passed) return failAttempt(ctx, p, spec, stored.data.findings);
    return move(ctx, p, 'ready', { findings: [] });
  }

  let pages = ctx.pages.get(version.versionId) ?? null;
  if (pages === null) {
    // A resume into check 2: the pages check 1 rendered are gone with the process.
    const bytes = await versionBytes(ctx, version);
    if (bytes === null) return fail(ctx, p, FILE_CHANGED_REASON);
    const rendered = await renderPages(ctx, { format: spec.format, bytes }, await flaggedSoFar(ctx, p.productionId));
    if ('failed' in rendered) return fail(ctx, p, rendered.failed);
    pages = rendered;
  }
  ctx.pages.delete(version.versionId);
  const seen = pages;

  let outcome: Awaited<ReturnType<DocJudge>>;
  try {
    outcome = await timed('judge', ctx.deadlines.judge, (signal) =>
      ctx.judge(
        {
          bundle: ctx.active.bundle,
          instruction: p.instructionText,
          kind: p.kind,
          language: p.language,
          text: seen.text,
          pages: seen.pages,
        },
        signal,
      ),
    );
  } catch (err) {
    return fail(ctx, p, err instanceof StageTimeout ? TIMEOUT_REASON.judge : JUDGE_FAILED_REASON);
  }

  // The card's preview: check 2's first page, stored beside the version.
  let previewPath: string | null = null;
  const first = seen.pages[0];
  if (first !== undefined) {
    previewPath = relativeFilePath(p, version.versionId, 'preview.png');
    await mkdir(dirname(join(ctx.documentRoot, previewPath)), { recursive: true });
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
    ctx.db,
    version.versionId,
    'check2',
    {
      passed,
      status: outcome.status,
      findings,
      criteria: outcome.status === 'judged' ? outcome.criteria : [],
      pageCount: seen.pageCount,
      previewPath,
    },
  );
  await ctx.checkpoint('check2_saved', p.productionId);
  if (!passed) return failAttempt(ctx, p, spec, findings);
  return move(ctx, p, 'ready', { findings: [] });
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
      return move(ctx, p, 'drafting');
    case 'ready':
    case 'failed_checks':
    case 'failed':
      throw new InvariantBroken(`step called on terminal stage ${p.stage}`);
  }
}

/** What a stage may spend on external calls — the deadlines it can run into. */
export function stageCostMs(stage: ProductionStage, deadlines: StageDeadlines, pagesInHand: boolean): number {
  switch (stage) {
    case 'drafting':
      return deadlines.draft;
    case 'building':
      return deadlines.render;
    case 'check1':
      return deadlines.pageRender;
    case 'check2':
      return (pagesInHand ? 0 : deadlines.pageRender) + deadlines.judge;
    case 'queued':
    case 'fixing':
    case 'ready':
    case 'failed_checks':
    case 'failed':
      return 0;
  }
}

async function reload(ctx: Ctx, productionId: string): Promise<Production> {
  const p = await loadProduction(ctx.db, productionId);
  if (p === null) throw new Error(`production ${productionId} vanished`);
  return p;
}

const isTerminal = (stage: ProductionStage): stage is ProductionFinished['stage'] =>
  stage === 'ready' || stage === 'failed_checks' || stage === 'failed';

/**
 * The version a finished production hands on: only for `ready` /
 * `failed_checks`, and only when it belongs to the final attempt — a version
 * from an earlier attempt (the final draft failed `validateSpec`) is not what
 * the findings are about.
 */
async function finishedVersionId(ctx: Ctx, p: Production): Promise<string | null> {
  if (p.stage !== 'ready' && p.stage !== 'failed_checks') return null;
  const version = await latestVersion(ctx.db, p.productionId);
  return version !== null && version.versionNo === p.attempt + 1 ? version.versionId : null;
}

/** Origin job, audit row, callback — then `finished`. At least once. */
async function finish(ctx: Ctx, p: Production): Promise<void> {
  if (!isTerminal(p.stage) || p.work.finished) return;
  const stage = p.stage;
  const versionId = await finishedVersionId(ctx, p);
  const reason = stage === 'failed' ? (p.work.reason ?? RENDER_ERROR_HE.render_failed) : null;

  if ((await loadJob(ctx.db, p.originJobId)) === null) {
    // Deterministic: reported once, never retried into an endless `errored`.
    ctx.result.originJobMissing.push(p.productionId);
  } else {
    try {
      await transition(ctx.db, p.originJobId, {
        to: stage === 'failed' ? 'failed' : 'closed',
        expectFrom: 'followup',
        actor: 'orchestrator',
        reason: stage === 'failed' ? `הפקת המסמך נכשלה: ${reason}` : `הפקת המסמך הסתיימה: ${productionStageLabel[stage]}`,
      });
    } catch (err) {
      if (!(err instanceof PhaseMovedError)) throw err;
      ctx.result.skipped += 1;
    }
  }

  await appendAudit(
    ctx.db,
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
    }
  );

  await ctx.onFinished({ productionId: p.productionId, versionId, stage, reason });
  // Merge, never overwrite, what the callback recorded on the row: the card
  // module claims `work.notified` inside `onFinished` (production/card.ts),
  // and `p.work` was read before it ran.
  const current = await loadProduction(ctx.db, p.productionId);
  await saveWork(
    ctx.db,
    p.productionId,
    stage,
    { ...p.work, notified: p.work.notified || current?.work.notified === true, finished: true },
  );

  if (stage === 'ready') ctx.result.ready += 1;
  else if (stage === 'failed_checks') ctx.result.failedChecks += 1;
  else ctx.result.failed += 1;
}

interface Budget {
  /** May a stage costing `costMs` start now? */
  allows(costMs: number): boolean;
}

/**
 * Advance one production until it is terminal, a race is lost, or the budget
 * cannot cover the next stage. Returns false when the budget stopped it (the
 * pass should stop).
 */
async function drive(ctx: Ctx, first: Production, budget: Budget): Promise<boolean> {
  let p = first;
  while (!isTerminal(p.stage)) {
    const version = p.stage === 'check2' ? await latestVersion(ctx.db, p.productionId) : null;
    const pagesInHand = version !== null && ctx.pages.has(version.versionId);
    if (!budget.allows(stageCostMs(p.stage, ctx.deadlines, pagesInHand))) return false;
    let outcome: StepOutcome;
    try {
      outcome = await step(ctx, p);
    } catch (err) {
      if (!(err instanceof InvariantBroken)) throw err;
      outcome = await fail(ctx, p, RENDER_ERROR_HE.render_failed);
    }
    if (outcome === 'lost') {
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

function newResult(): RunProductionsResult {
  return { advanced: 0, ready: 0, failedChecks: 0, failed: 0, skipped: 0, errored: [], originJobMissing: [] };
}

/**
 * Run the loop for one business. `null` when production cannot run on this
 * server (`runtime.production` absent or unavailable, and no seams injected)
 * — "did not run", never zeros, which would read as "nothing to do". Even
 * then, every claimable non-terminal production is ended `failed` with
 * `PRODUCTION_TOOLS_MISSING_REASON` and finished, so none waits forever.
 */
export async function runDocumentProductions(
  db: BusinessDb,
  options: RunProductionsOptions = {},
): Promise<RunProductionsResult | null> {
  const businessId = db.businessId;
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
  const unavailable = printer === null || renderer === null;

  const active = await loadActiveCharter(db);
  if (active === null) {
    if (unavailable) return null;
    throw new Error(`runDocumentProductions: no active charter for ${businessId}`);
  }

  const images = options.images ?? createDbImageLoader(db);
  const now = (): Date => options.now ?? new Date();
  const result = newResult();
  const unusable = async (): Promise<never> => {
    throw new Error('production tools are not available');
  };
  const ctx: Ctx = {
    db,
    active,
    currency: active.bundle.ceilings.currency,
    drafter: options.drafter ?? (async (request, signal) => (await import('../sdk/doc-drafter.js')).draftDocumentSpec(request, signal)),
    judge: options.judge ?? (async (request, signal) => (await import('../sdk/doc-judge.js')).judgeDocument(request, signal)),
    printer: printer ?? unusable,
    renderer: renderer ?? unusable,
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
    pages: new Map(),
  };

  const clock = options.clock ?? Date.now;
  const started = clock();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  let spentOnce = false;
  const hasBudget = (): boolean => clock() - started < budgetMs;
  const budget: Budget = {
    allows(costMs) {
      if (costMs === 0) return hasBudget();
      // The first costed stage of the pass always starts — see the docblock.
      if (!spentOnce) {
        spentOnce = true;
        return true;
      }
      return budgetMs - (clock() - started) >= costMs;
    },
  };
  const holder = options.holder ?? `scheduler-${process.pid}`;
  const leaseMs = options.leaseMs ?? PRODUCTION_LEASE_MS;
  const attempted: string[] = [];

  // Stragglers first: terminal rows whose side effects a crash interrupted.
  while (hasBudget()) {
    const p = await claimUnfinished(db, holder, leaseMs, attempted);
    if (p === null) break;
    attempted.push(p.productionId);
    try {
      await finish(ctx, p);
    } catch (err) {
      result.errored.push({ productionId: p.productionId, error: errorText(err) });
    } finally {
      await releaseLease(db, p.productionId, holder);
    }
  }

  while (hasBudget()) {
    const p = await claimProduction(db, holder, leaseMs, attempted);
    if (p === null) break;
    attempted.push(p.productionId);
    let keepGoing = true;
    try {
      if (unavailable) {
        // Nothing can be built here: end it now rather than leave it queued forever.
        if ((await fail(ctx, p, PRODUCTION_TOOLS_MISSING_REASON)) === 'lost') result.skipped += 1;
        else await finish(ctx, await reload(ctx, p.productionId));
      } else {
        keepGoing = await drive(ctx, p, budget);
      }
    } catch (err) {
      result.errored.push({ productionId: p.productionId, error: errorText(err) });
    } finally {
      await releaseLease(db, p.productionId, holder);
    }
    if (!keepGoing) break;
  }
  return unavailable ? null : result;
}
