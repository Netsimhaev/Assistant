/**
 * Handlers for `/documents` (document production §4, §8.1, C12, D13): the
 * list of cards, one card, its download and preview, the three owner actions
 * (approve an option, ask for a fix, type an address) and the settings page.
 * Rendering is in `document-views.ts`; decisions are in `production/card.ts`
 * — this file reads, checks CSRF, and calls them.
 *
 * Every read is scoped to `businessId`; a card of another business is a 404.
 * Every POST verifies CSRF before anything else.
 *
 * **The approve POST takes a plan hash and nothing else.** The hash must be
 * one the card holds AND one the server rebuilds (`approveDocumentCard`); no
 * recipient, folder or file ever rides in the approve form. A recipient the
 * owner types (C12) goes through its own route, `POST …/address`, which
 * rebuilds the card's options server-side; the owner then approves the new
 * option like any other, after seeing its full echo.
 *
 * **The download re-hashes from disk before serving** (`readVersionBytes`):
 * bytes that no longer match the version's sha256 are refused, never served.
 * `Content-Disposition: attachment` with the RFC 5987 name, `nosniff`.
 *
 * `GET /documents` marks the cards it just listed as seen — a GET that
 * mutates, the same known issue as `/ledger` and `/autonomy/actions`
 * (CLAUDE.md, "בעיות ידועות"): a cross-site navigation can clear the "new"
 * mark, nothing else.
 */
import type { ServerResponse } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { loadActiveCharter } from '../charter/store.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { FORMAT_MEDIA_TYPE, formatAttachmentSize } from '../domain/attachment-ref.js';
import { DocumentKind } from '../domain/document-spec.js';
import {
  DOCUMENT_SETTINGS_HE,
  loadDocumentSettings,
  saveDocumentSettings,
} from '../governance/document-settings.js';
import { renderStepEcho } from '../orchestrator/command-echo.js';
import type { Runtime } from '../orchestrator/runtime.js';
import { canonicalAttachmentName, loadVersionFile, readVersionBytes } from '../production/attachments.js';
import {
  addTypedRecipient,
  approveDocumentCard,
  CardState,
  loadDocumentCard,
  requestFix,
  type DocumentCard,
} from '../production/card.js';
import { loadProduction, loadVersion, sourceProvenance, type Production } from '../production/store.js';
import { stripBidiControls } from '../util/bidi.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import {
  renderDocumentCard,
  renderDocumentList,
  renderDocumentSettings,
  type CheckView,
  type DocumentListRow,
  type SourceView,
} from './document-views.js';
import { rfc5987 } from './mail-handlers.js';
import { renderForbidden, renderNotFound } from './views.js';

export interface DocumentSession {
  sessionId: string;
}

export interface DocumentRouteOptions {
  /**
   * `runtime.production` for this dashboard process — a fix is a new
   * production, refused up front when this server cannot produce. Defaults
   * to the same two env vars `buildRuntime` reads.
   */
  production?: Runtime['production'];
  /** The dashboard's document root (`DashboardOptions.documentRoot`); `config.documentRoot` when unset. */
  documentRoot?: string;
}

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } as const;
const LIST_LIMIT = 200;

export const DOWNLOAD_CHANGED_HE = 'הקובץ השתנה מאז שנבדק — לא הורדתי אותו.';
export const CARD_STALE_HE = 'הכרטיס השתנה או כבר הוכרע — לא ביצעתי דבר. הכרטיס מוצג מחדש.';

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(body);
}

function seeOther(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS });
  res.end();
}

/** The production tools as `buildRuntime` reads them, for a dashboard started without a runtime. */
export function productionToolsFromEnv(env: NodeJS.ProcessEnv = process.env): NonNullable<Runtime['production']> {
  const path = (key: string): string | null => {
    const value = env[key];
    return value === undefined || value.length === 0 ? null : value;
  };
  const sofficePath = path('DOCUMENT_SOFFICE_PATH');
  const chromiumPath = path('DOCUMENT_CHROMIUM_PATH');
  return { available: sofficePath !== null && chromiumPath !== null, sofficePath, chromiumPath };
}

export const CHARTER_UNREADABLE_HE =
  'לא הצלחתי לקרוא את התקנון הפעיל, ולכן אינני מציגה מסמכים — בלי התקנון אינני יודעת באיזה מטבע ובאיזה אזור זמן להציג אותם. אפשר לתקן אותו בעריכת הכללים.';

/**
 * The charter's zone and currency, or `null` when the active charter cannot
 * be read. Refused, never defaulted: a card whose amounts are shown in a
 * guessed currency is a card whose echo is not what will run.
 */
async function charterContext(businessId: string): Promise<{ timeZone: string; currency: string } | null> {
  try {
    const active = await loadActiveCharter(businessId);
    return active === null
      ? null
      : { timeZone: active.charter.identity.timezone, currency: active.bundle.ceilings.currency };
  } catch {
    return null;
  }
}

function charterUnreadable(res: ServerResponse): void {
  html(
    res,
    503,
    `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>מסמכים</title></head><body><p>${CHARTER_UNREADABLE_HE}</p><p><a href="/setup/edit">עריכת הכללים</a></p></body></html>`,
  );
}

const ACTIONABLE: readonly CardState[] = ['open', 'failed_send'];

// ---------------------------------------------------------------- list

interface ListRow {
  card_id: string;
  state: string;
  kind: string;
  title: string | null;
  created_at: Date;
  seen_at: Date | null;
  stage: string;
}

export async function handleDocumentList(res: ServerResponse, businessId: string, session: DocumentSession): Promise<void> {
  // Before anything is read or marked seen.
  const context = await charterContext(businessId);
  if (context === null) return charterUnreadable(res);
  const { rows } = await getPool().query<ListRow>(
    `SELECT c.card_id, c.state, p.kind, v.spec->>'title' AS title, c.created_at, c.seen_at, p.stage
       FROM document_cards c
       JOIN document_versions v ON v.version_id = c.version_id
       JOIN document_productions p ON p.production_id = v.production_id AND p.business_id = c.business_id
      WHERE c.business_id = $1
      ORDER BY (c.state IN ('open', 'failed_send')) DESC, c.created_at DESC, c.card_id DESC
      LIMIT $2`,
    [businessId, LIST_LIMIT + 1],
  );
  const truncated = rows.length > LIST_LIMIT;
  const shown = rows.slice(0, LIST_LIMIT);
  const listRows: DocumentListRow[] = [];
  for (const row of shown) {
    const state = CardState.safeParse(row.state);
    const kind = DocumentKind.safeParse(row.kind);
    if (!state.success || !kind.success) continue;
    listRows.push({
      cardId: row.card_id,
      state: state.data,
      kind: kind.data,
      title: row.title ?? '',
      createdAt: row.created_at,
      failedChecks: row.stage === 'failed_checks',
      isNew: row.seen_at === null,
    });
  }
  // A GET that mutates — see the module docblock.
  if (shown.length > 0) {
    await getPool().query(
      `UPDATE document_cards SET seen_at = now()
        WHERE business_id = $1 AND card_id = ANY($2::text[]) AND seen_at IS NULL`,
      [businessId, shown.map((r) => r.card_id)],
    );
  }
  html(res, 200, renderDocumentList({ rows: listRows, timeZone: context.timeZone, csrf: issueCsrfToken(session.sessionId), truncated }));
}

// ---------------------------------------------------------------- one card

interface Loaded {
  card: DocumentCard;
  production: Production;
  version: NonNullable<Awaited<ReturnType<typeof loadVersion>>>;
}

async function loadCard(businessId: string, cardId: string): Promise<Loaded | null> {
  const card = await loadDocumentCard(businessId, cardId);
  if (card === null) return null;
  const version = await loadVersion(businessId, card.versionId);
  if (version === null) return null;
  const production = await loadProduction(businessId, version.productionId);
  if (production === null) return null;
  return { card, production, version };
}

const StoredCheck = z.object({
  passed: z.boolean(),
  findings: z.array(z.object({ he: z.string(), where: z.string(), detail: z.string().optional() }).passthrough()),
  previewPath: z.string().nullable().optional(),
});

function checkView(raw: unknown): CheckView {
  const parsed = StoredCheck.safeParse(raw);
  if (!parsed.success) return { passed: null, findings: [] };
  return {
    passed: parsed.data.passed,
    findings: parsed.data.findings.map((f) => ({ he: f.he, where: f.where, ...(f.detail !== undefined ? { detail: f.detail } : {}) })),
  };
}

function previewPathOf(raw: unknown): string | null {
  const parsed = StoredCheck.safeParse(raw);
  return parsed.success ? (parsed.data.previewPath ?? null) : null;
}

/**
 * The stored file under `documentRoot` — the dashboard's own root, the one
 * the upload and the production loop write under — resolved and contained;
 * `null` when absent or escaping.
 */
async function containedFile(stored: string, documentRoot: string | undefined): Promise<string | null> {
  const root = resolve(documentRoot ?? config.documentRoot);
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolve(root, stored))]);
    const rel = relative(realRoot, realFile);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return realFile;
  } catch {
    return null;
  }
}

async function sourcesOf(businessId: string, production: Production): Promise<SourceView[]> {
  const sources: SourceView[] = [];
  if (production.sourceDocumentIds.length > 0) {
    const { rows } = await getPool().query<{ document_id: string; original_name: string }>(
      `SELECT document_id, original_name FROM documents
        WHERE business_id = $1 AND document_id = ANY($2::text[])
        ORDER BY array_position($2::text[], document_id)`,
      [businessId, production.sourceDocumentIds],
    );
    for (const row of rows) {
      sources.push({ label: `מסמך: ${row.original_name}`, provenance: sourceProvenance(production, row.document_id) });
    }
  }
  const memoryIds = production.work.memoryIds ?? [];
  if (memoryIds.length > 0) {
    const { rows } = await getPool().query<{ subject_key: string; provenance: string }>(
      `SELECT subject_key, provenance FROM memories
        WHERE business_id = $1 AND memory_id = ANY($2::text[])
        ORDER BY array_position($2::text[], memory_id)`,
      [businessId, memoryIds],
    );
    for (const row of rows) sources.push({ label: `זיכרון: ${row.subject_key}`, provenance: row.provenance });
  }
  return sources;
}

async function renderCard(
  res: ServerResponse,
  status: number,
  businessId: string,
  session: DocumentSession,
  loaded: Loaded,
  documentRoot: string | undefined,
  error?: string,
): Promise<void> {
  const { card, production, version } = loaded;
  const context = await charterContext(businessId);
  if (context === null) return charterUnreadable(res);
  const { currency } = context;
  const settings = await loadDocumentSettings({ businessId });
  const previewPath = previewPathOf(version.check2);
  const hasPreview = previewPath !== null && (await containedFile(previewPath, documentRoot)) !== null;
  const failedChecks = production.stage === 'failed_checks';
  html(
    res,
    status,
    renderDocumentCard({
      cardId: card.cardId,
      state: card.state,
      actionable: ACTIONABLE.includes(card.state) && version.supersededAt === null,
      kind: version.spec.kind,
      title: version.spec.title,
      failedChecks,
      file: {
        name: canonicalAttachmentName({ spec: version.spec, format: production.format }),
        size: formatAttachmentSize(version.sizeBytes),
        shaPrefix: version.sha256.slice(0, 12),
      },
      hasPreview,
      check1: checkView(version.check1),
      check2: checkView(version.check2),
      findings: failedChecks ? production.findings.map((f) => ({ he: f.he, where: f.where })) : [],
      notes: production.work.notes,
      sources: await sourcesOf(businessId, production),
      options: card.deliveryPlans.map((option) => ({
        option,
        echo: option.plan.steps.map((step) => renderStepEcho(step, currency)).filter((e) => e !== '').join('\n'),
        pressable: option.option === 'send' || settings.baseFolder !== null,
      })),
      needsAddress:
        production.stage === 'ready' &&
        production.destination.mode === 'send' &&
        !card.deliveryPlans.some((o) => o.option === 'send'),
      csrf: issueCsrfToken(session.sessionId),
      ...(error !== undefined ? { error } : {}),
    }),
  );
}

export async function handleDocumentCard(
  res: ServerResponse,
  businessId: string,
  session: DocumentSession,
  cardId: string,
  documentRoot: string | undefined,
): Promise<void> {
  const loaded = await loadCard(businessId, cardId);
  if (loaded === null) return html(res, 404, renderNotFound());
  return renderCard(res, 200, businessId, session, loaded, documentRoot);
}

export async function handleDocumentPreview(
  res: ServerResponse,
  businessId: string,
  cardId: string,
  documentRoot: string | undefined,
): Promise<void> {
  const loaded = await loadCard(businessId, cardId);
  const stored = loaded === null ? null : previewPathOf(loaded.version.check2);
  const file = stored === null ? null : await containedFile(stored, documentRoot);
  if (file === null) return html(res, 404, renderNotFound());
  let bytes: Buffer;
  try {
    const handle = await open(file, 'r');
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return html(res, 404, renderNotFound());
  }
  // A PNG we wrote, but checked anyway: anything else is not served as an image.
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return html(res, 404, renderNotFound());
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': String(bytes.length),
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS,
  });
  res.end(bytes);
}

export async function handleDocumentDownload(res: ServerResponse, businessId: string, cardId: string): Promise<void> {
  const loaded = await loadCard(businessId, cardId);
  if (loaded === null) return html(res, 404, renderNotFound());
  const file = await loadVersionFile(loaded.version.versionId, businessId);
  if (file === null) return html(res, 404, renderNotFound());
  const read = await readVersionBytes(file, { sha256: loaded.version.sha256, sizeBytes: loaded.version.sizeBytes });
  if (!read.ok) {
    if (read.code === 'attachment_hash_mismatch') {
      return html(res, 409, renderDownloadRefused());
    }
    return html(res, 404, renderNotFound());
  }
  const name = stripBidiControls(file.filename).replace(/[\u{0}-\u{1f}\u{7f}]/gu, '') || 'document';
  res.writeHead(200, {
    'Content-Type': FORMAT_MEDIA_TYPE[file.format],
    'Content-Length': String(read.bytes.length),
    'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${rfc5987(name)}`,
    'X-Content-Type-Options': 'nosniff',
    ...SECURITY_HEADERS,
  });
  res.end(read.bytes);
}

function renderDownloadRefused(): string {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>הורדה</title></head><body><p>${DOWNLOAD_CHANGED_HE}</p><p><a href="/documents">חזרה למסמכים</a></p></body></html>`;
}

// ---------------------------------------------------------------- actions

export async function handleDocumentApprove(
  res: ServerResponse,
  businessId: string,
  session: DocumentSession,
  cardId: string,
  form: URLSearchParams,
  options: DocumentRouteOptions = {},
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  // The plan hash and nothing else — see the module docblock.
  const planHash = form.get('planHash') ?? '';
  const outcome = await approveDocumentCard(cardId, planHash, 'dashboard', { businessId });
  if (outcome.status === 'approved') return seeOther(res, `/documents/${encodeURIComponent(cardId)}`);
  if (outcome.status === 'not_found') return html(res, 404, renderNotFound());
  const loaded = await loadCard(businessId, cardId);
  if (loaded === null) return html(res, 404, renderNotFound());
  return renderCard(res, 409, businessId, session, loaded, options.documentRoot, CARD_STALE_HE);
}

export async function handleDocumentFix(
  res: ServerResponse,
  businessId: string,
  session: DocumentSession,
  cardId: string,
  form: URLSearchParams,
  options: DocumentRouteOptions,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  // The dashboard form is the owner's own keystrokes.
  const outcome = await requestFix(cardId, form.get('text') ?? '', 'dashboard', 'typed', {
    businessId,
    production: options.production ?? productionToolsFromEnv(),
  });
  if (outcome.status === 'opened') return seeOther(res, '/documents');
  if (outcome.status === 'not_found') return html(res, 404, renderNotFound());
  const loaded = await loadCard(businessId, cardId);
  if (loaded === null) return html(res, 404, renderNotFound());
  return renderCard(
    res,
    outcome.status === 'refused' ? 400 : 409,
    businessId,
    session,
    loaded,
    options.documentRoot,
    outcome.status === 'refused' ? outcome.reason : CARD_STALE_HE,
  );
}

/** C12 — the owner types the address; the server rebuilds the card's options. */
export async function handleDocumentAddress(
  res: ServerResponse,
  businessId: string,
  session: DocumentSession,
  cardId: string,
  form: URLSearchParams,
  options: DocumentRouteOptions = {},
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  // The dashboard has no notification seams of its own: no re-send happens
  // here, the card's channel states are left as they were, and the WhatsApp
  // delivery stays withdrawn until a card is delivered there again.
  const outcome = await addTypedRecipient(cardId, form.get('to') ?? '', { businessId });
  if (outcome.status === 'added') return seeOther(res, `/documents/${encodeURIComponent(cardId)}`);
  if (outcome.status === 'not_found') return html(res, 404, renderNotFound());
  const loaded = await loadCard(businessId, cardId);
  if (loaded === null) return html(res, 404, renderNotFound());
  return renderCard(
    res,
    outcome.status === 'refused' ? 400 : 409,
    businessId,
    session,
    loaded,
    options.documentRoot,
    outcome.status === 'refused' ? outcome.reason : CARD_STALE_HE,
  );
}

// ---------------------------------------------------------------- settings

export async function handleDocumentSettingsGet(res: ServerResponse, businessId: string, session: DocumentSession): Promise<void> {
  const settings = await loadDocumentSettings({ businessId });
  html(res, 200, renderDocumentSettings({ csrf: issueCsrfToken(session.sessionId), ...settings }));
}

const SETTINGS_REFUSALS: ReadonlySet<string> = new Set(Object.values(DOCUMENT_SETTINGS_HE));

export async function handleDocumentSettingsPost(
  res: ServerResponse,
  businessId: string,
  session: DocumentSession,
  form: URLSearchParams,
): Promise<void> {
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) return html(res, 403, renderForbidden());
  const chosen = {
    toWhatsApp: form.get('toWhatsApp') === 'on',
    toEmail: form.get('toEmail') === 'on',
    toScreen: form.get('toScreen') === 'on',
    baseFolder: (form.get('baseFolder') ?? '').trim() || null,
  };
  try {
    await saveDocumentSettings(chosen, { businessId });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (!SETTINGS_REFUSALS.has(message)) throw err;
    return html(
      res,
      400,
      renderDocumentSettings({ csrf: issueCsrfToken(session.sessionId), ...chosen, error: message }),
    );
  }
  return seeOther(res, '/documents/settings');
}
