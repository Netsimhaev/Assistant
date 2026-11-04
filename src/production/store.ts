/**
 * The production store: one `document_productions` row per request and one
 * `document_versions` row per built file (migration 053).
 *
 * **The `findings` column is the production's working record**, typed here
 * as `ProductionWork` and exposed as `Production.work`. It carries what a
 * stage must hand the next one across a crash — the spec the drafter wrote
 * and `validateSpec` accepted (awaiting a build), the memory ids the drafter
 * saw (so every later stage grounds against the same set), the previous
 * attempt for a fix round — and the most recent findings and failure reason
 * the card shows. One JSON column rather than new columns because migration
 * 053 is the branch's only migration and has already run; the shape is
 * parsed on every read, so a malformed row reads as an empty record rather
 * than as a value nobody checked.
 *
 * **Leases.** `claimProduction` is ONE conditional `UPDATE … RETURNING`: a
 * row is taken only when it is not terminal and its lease is absent or past.
 * Two schedulers racing for the same row both run the statement; Postgres
 * serialises the row update and the second re-evaluates the `WHERE` against
 * the first's write, so exactly one gets it back.
 *
 * **`advanceStage` is conditional on the stage it moves FROM.** `false` means
 * the row was no longer in that stage — the race was lost, which a caller
 * treats as a skip, never as an error.
 */
import { localParts, localToInstant } from '../util/local-time.js';
import { z } from 'zod';
import { getPool, type Queryable } from '../db/pool.js';
import {
  DocumentFormat,
  DocumentKind,
  DocumentLanguage,
  DocumentSpec,
  ProductionStage,
} from '../domain/document-spec.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { ulid } from 'ulid';

export const TERMINAL_STAGES: readonly ProductionStage[] = ['ready', 'failed_checks', 'failed'];

export const ProductionDestination = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('send'),
      to: z.array(z.string()),
      subject: z.string().optional(),
      body: z.string().optional(),
    })
    .strict(),
  z.object({ mode: z.literal('save'), folder: z.string().nullable() }).strict(),
]);
export type ProductionDestination = z.infer<typeof ProductionDestination>;

/** One finding as the card and the next drafter see it. `he` is fixed text; `detail` may quote the spec. */
export const ProductionFinding = z
  .object({
    check: z.enum(['spec', 'check1', 'check2']),
    code: z.string(),
    where: z.string(),
    he: z.string(),
    detail: z.string().optional(),
  })
  .strict();
export type ProductionFinding = z.infer<typeof ProductionFinding>;

export const ProductionWork = z
  .object({
    /** True once the first draft call was started — what the daily cap counts. */
    drafted: z.boolean().default(false),
    /** The memory rows the drafter received, fixed at the first draft; null before it. */
    memoryIds: z.array(z.string()).nullable().default(null),
    /** The spec that passed `validateSpec`, awaiting `building`. */
    draft: z.unknown().nullable().default(null),
    /** The attempt that failed, handed to the next draft as `previous`. */
    previous: z
      .object({ spec: z.unknown(), findings: z.array(z.object({ he: z.string() }).strict()) })
      .strict()
      .nullable()
      .default(null),
    /** The most recent failing findings (spec, check 1 or check 2). */
    findings: z.array(ProductionFinding).default([]),
    /** The owner-facing reason a production ended `failed`. */
    reason: z.string().nullable().default(null),
    /** True once the terminal side effects (origin job, audit, `onFinished`) ran. */
    finished: z.boolean().default(false),
  })
  .strict();
export type ProductionWork = z.infer<typeof ProductionWork>;

export const EMPTY_WORK: ProductionWork = ProductionWork.parse({});

export interface Production {
  productionId: string;
  businessId: string;
  originJobId: string;
  instructionText: string;
  textOrigin: InstructionTextOrigin;
  format: DocumentFormat;
  language: DocumentLanguage;
  kind: DocumentKind;
  destination: ProductionDestination;
  sourceDocumentIds: string[];
  stage: ProductionStage;
  attempt: number;
  /** The `findings` column — see the module docblock. */
  work: ProductionWork;
  leaseUntil: Date | null;
  leasedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProductionRow {
  production_id: string;
  business_id: string;
  origin_job_id: string;
  instruction_text: string;
  text_origin: string;
  format: string;
  language: string;
  kind: string;
  destination: unknown;
  source_document_ids: string[];
  stage: string;
  attempt: number;
  findings: unknown;
  lease_until: Date | null;
  leased_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function toWork(raw: unknown): ProductionWork {
  const parsed = ProductionWork.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { ...EMPTY_WORK };
}

function toProduction(row: ProductionRow): Production {
  return {
    productionId: row.production_id,
    businessId: row.business_id,
    originJobId: row.origin_job_id,
    instructionText: row.instruction_text,
    textOrigin: row.text_origin === 'typed' ? 'typed' : 'transcribed',
    format: DocumentFormat.parse(row.format),
    language: DocumentLanguage.parse(row.language),
    kind: DocumentKind.parse(row.kind),
    destination: ProductionDestination.parse(row.destination),
    sourceDocumentIds: row.source_document_ids,
    stage: ProductionStage.parse(row.stage),
    attempt: row.attempt,
    work: toWork(row.findings),
    leaseUntil: row.lease_until,
    leasedBy: row.leased_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateProductionInput {
  businessId: string;
  originJobId: string;
  instructionText: string;
  textOrigin: InstructionTextOrigin;
  format: DocumentFormat;
  language: DocumentLanguage;
  kind: DocumentKind;
  destination: ProductionDestination;
  sourceDocumentIds: string[];
}

export async function createProduction(input: CreateProductionInput, db: Queryable = getPool()): Promise<string> {
  const productionId = `DP-${ulid()}`;
  const destination = ProductionDestination.parse(input.destination);
  await db.query(
    `INSERT INTO document_productions
       (production_id, business_id, origin_job_id, instruction_text, text_origin, format, language, kind,
        destination, source_document_ids, findings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      productionId,
      input.businessId,
      input.originJobId,
      input.instructionText,
      input.textOrigin,
      DocumentFormat.parse(input.format),
      DocumentLanguage.parse(input.language),
      DocumentKind.parse(input.kind),
      JSON.stringify(destination),
      input.sourceDocumentIds,
      JSON.stringify(EMPTY_WORK),
    ],
  );
  return productionId;
}

export async function loadProduction(
  businessId: string,
  productionId: string,
  db: Queryable = getPool(),
): Promise<Production | null> {
  const { rows } = await db.query<ProductionRow>(
    'SELECT * FROM document_productions WHERE business_id = $1 AND production_id = $2',
    [businessId, productionId],
  );
  const row = rows[0];
  return row === undefined ? null : toProduction(row);
}

/**
 * Take one non-terminal production whose lease is free, oldest first, and
 * lease it to `holder` for `leaseMs`. `exclude` keeps a pass from re-taking a
 * production it already gave up on this pass (a lost race, an error).
 */
export async function claimProduction(
  businessId: string,
  holder: string,
  leaseMs: number,
  db: Queryable = getPool(),
  exclude: readonly string[] = [],
): Promise<Production | null> {
  const { rows } = await db.query<ProductionRow>(
    `UPDATE document_productions
        SET lease_until = now() + make_interval(secs => $3::double precision / 1000),
            leased_by = $2,
            updated_at = now()
      WHERE production_id = (
              SELECT production_id FROM document_productions
               WHERE business_id = $1
                 AND stage NOT IN ('ready', 'failed_checks', 'failed')
                 AND (lease_until IS NULL OR lease_until < now())
                 AND NOT (production_id = ANY($4::text[]))
               ORDER BY created_at, production_id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        AND stage NOT IN ('ready', 'failed_checks', 'failed')
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING *`,
    [businessId, holder, leaseMs, [...exclude]],
  );
  const row = rows[0];
  return row === undefined ? null : toProduction(row);
}

/**
 * Take one TERMINAL production whose side effects (`finished`) have not run,
 * with the same lease. A crash between reaching a terminal stage and closing
 * the origin job / telling the owner is resumed here — at least once.
 */
export async function claimUnfinished(
  businessId: string,
  holder: string,
  leaseMs: number,
  db: Queryable = getPool(),
  exclude: readonly string[] = [],
): Promise<Production | null> {
  const { rows } = await db.query<ProductionRow>(
    `UPDATE document_productions
        SET lease_until = now() + make_interval(secs => $3::double precision / 1000),
            leased_by = $2
      WHERE production_id = (
              SELECT production_id FROM document_productions
               WHERE business_id = $1
                 AND stage IN ('ready', 'failed_checks', 'failed')
                 AND COALESCE((findings->>'finished')::boolean, false) = false
                 AND (lease_until IS NULL OR lease_until < now())
                 AND NOT (production_id = ANY($4::text[]))
               ORDER BY updated_at, production_id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING *`,
    [businessId, holder, leaseMs, [...exclude]],
  );
  const row = rows[0];
  return row === undefined ? null : toProduction(row);
}

export async function releaseLease(productionId: string, holder: string, db: Queryable = getPool()): Promise<void> {
  await db.query(
    `UPDATE document_productions SET lease_until = NULL, leased_by = NULL
      WHERE production_id = $1 AND leased_by = $2`,
    [productionId, holder],
  );
}

export interface StagePatch {
  attempt?: number;
  work?: ProductionWork;
}

/**
 * Move `from → to`, writing `patch` in the same statement. Conditional on
 * `stage = from`: `false` means another runner already moved it (a skip).
 */
export async function advanceStage(
  productionId: string,
  from: ProductionStage,
  to: ProductionStage,
  patch: StagePatch,
  db: Queryable = getPool(),
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE document_productions
        SET stage = $3,
            attempt = COALESCE($4::int, attempt),
            findings = COALESCE($5::jsonb, findings),
            updated_at = now()
      WHERE production_id = $1 AND stage = $2`,
    [
      productionId,
      ProductionStage.parse(from),
      ProductionStage.parse(to),
      patch.attempt ?? null,
      patch.work === undefined ? null : JSON.stringify(ProductionWork.parse(patch.work)),
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Overwrite the working record without moving the stage (conditional on the stage, like `advanceStage`). */
export async function saveWork(
  productionId: string,
  stage: ProductionStage,
  work: ProductionWork,
  db: Queryable = getPool(),
): Promise<boolean> {
  return advanceStage(productionId, stage, stage, { work }, db);
}

// ---------------------------------------------------------------- versions

export interface DocumentVersion {
  versionId: string;
  productionId: string;
  versionNo: number;
  spec: DocumentSpec;
  storedPath: string;
  sha256: string;
  sizeBytes: number;
  check1: unknown;
  check2: unknown;
  supersededAt: Date | null;
  createdAt: Date;
}

interface VersionRow {
  version_id: string;
  production_id: string;
  version_no: number;
  spec: unknown;
  stored_path: string;
  sha256: string;
  size_bytes: string | number;
  check1: unknown;
  check2: unknown;
  superseded_at: Date | null;
  created_at: Date;
}

function toVersion(row: VersionRow): DocumentVersion {
  return {
    versionId: row.version_id,
    productionId: row.production_id,
    versionNo: row.version_no,
    spec: DocumentSpec.parse(row.spec),
    storedPath: row.stored_path,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    check1: row.check1,
    check2: row.check2,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Deterministic, so a re-render after a crash overwrites the same file instead of orphaning one. */
export function versionIdFor(productionId: string, versionNo: number): string {
  return `DV-${productionId.replace(/^DP-/, '')}-${versionNo}`;
}

export interface SaveVersionInput {
  productionId: string;
  versionNo: number;
  spec: DocumentSpec;
  storedPath: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Insert one version; earlier versions of the production are marked
 * superseded in the same statement. Idempotent on `(production_id,
 * version_no)`: a re-run after a crash between the write and the stage move
 * returns the row already there.
 */
export async function saveVersion(input: SaveVersionInput, db: Queryable = getPool()): Promise<string> {
  const versionId = versionIdFor(input.productionId, input.versionNo);
  await db.query(
    `WITH ins AS (
       INSERT INTO document_versions (version_id, production_id, version_no, spec, stored_path, sha256, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (production_id, version_no) DO NOTHING
       RETURNING version_id)
     UPDATE document_versions SET superseded_at = now()
      WHERE production_id = $2 AND version_no < $3 AND superseded_at IS NULL`,
    [
      versionId,
      input.productionId,
      input.versionNo,
      JSON.stringify(input.spec),
      input.storedPath,
      input.sha256,
      input.sizeBytes,
    ],
  );
  return versionId;
}

export async function latestVersion(productionId: string, db: Queryable = getPool()): Promise<DocumentVersion | null> {
  const { rows } = await db.query<VersionRow>(
    `SELECT * FROM document_versions WHERE production_id = $1 ORDER BY version_no DESC LIMIT 1`,
    [productionId],
  );
  const row = rows[0];
  return row === undefined ? null : toVersion(row);
}

export async function saveVersionCheck(
  versionId: string,
  check: 'check1' | 'check2',
  result: unknown,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(`UPDATE document_versions SET ${check === 'check1' ? 'check1' : 'check2'} = $2 WHERE version_id = $1`, [
    versionId,
    JSON.stringify(result),
  ]);
}

/**
 * Draft calls started today, the day beginning at local midnight in the
 * charter zone: productions created today whose first draft was started
 * (`work.drafted` — a row refused at the cap never was), plus their fix
 * attempts (`attempt`). A fix attempt on a production created before
 * midnight is not counted — at most two per such production.
 */
export async function productionsToday(
  businessId: string,
  timeZone: string,
  db: Queryable = getPool(),
  now: Date = new Date(),
): Promise<number> {
  const start = localToInstant(localParts(now, timeZone).date, '00:00', timeZone);
  const { rows } = await db.query<{ n: string }>(
    `SELECT (COUNT(*) FILTER (WHERE COALESCE((findings->>'drafted')::boolean, false))
             + COALESCE(SUM(attempt), 0))::text AS n
       FROM document_productions
      WHERE business_id = $1 AND created_at >= $2`,
    [businessId, start],
  );
  return Number(rows[0]?.n ?? 0);
}
