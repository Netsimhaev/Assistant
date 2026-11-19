/**
 * The panel's external-system screens (Stage D): a technician writes a
 * system definition as a draft and stores its secrets. The owner signs it on
 * his own dashboard later (Task 10) — nothing here makes a definition live.
 *
 * Routes, all behind the panel's session and (for POST) its CSRF token:
 * - `GET  /businesses/:id/external`               the systems and their status
 * - `GET  /businesses/:id/external/:system`       the draft editor and preview
 * - `POST /businesses/:id/external/:system/save`
 * - `POST /businesses/:id/external/:system/delete`
 * - `POST /businesses/:id/external/:system/secret`  `kind=key|hook|verify`, `value`
 *
 * **What the technician sees.** Status flags (`businessDetailForPanel`), and
 * the DRAFT text he wrote himself — read on the business's own connection
 * under RLS, never through the platform pool. Never the signed definition's
 * content (with no draft the editor holds a blank template), and never
 * anything a system returned (`external_events`, `external_reads`).
 *
 * **Secrets are never echoed.** The answer to a save is a redirect; the page
 * shows `✓ שמור` / `חסר`; the activity row carries `{ kind }` only.
 *
 * **The id is fixed by the route.** It must match `EXTERNAL_SYSTEM_ID`, and a
 * definition whose `id` differs is refused.
 */
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { isValidBusinessId, withBusiness } from '../db/pool.js';
import { EXTERNAL_SYSTEM_ID, ExternalSystem, externalSecretRefs } from '../domain/external-system.js';
import { deleteDraft, loadDrafts, saveDraft } from '../external/store.js';
import { describeExternalSystem } from '../external/describe.js';
import { putSecret } from '../governance/credential-store.js';
import { getBusiness } from '../tenancy/businesses.js';
import { businessDetailForPanel, type ExternalSystemPanelStatus } from '../tenancy/panel-reads.js';
import { escapeHtml } from '../util/html.js';
import { stripBidiControls } from '../util/bidi.js';
import { recordStaffAction, type RecordingStaff } from './record.js';
import {
  EXTERNAL_STATE_LABELS,
  page,
  renderExternalStatusTable,
  renderForbidden,
  renderNotFound,
  secretCell,
  type PanelViewer,
} from './views.js';

export const EXTERNAL_JSON_INVALID = 'הטקסט אינו JSON תקין — בדוק פסיקים, מירכאות וסוגריים.';
export const EXTERNAL_ID_INVALID =
  'מזהה מערכת לא תקין — אותיות אנגליות קטנות, ספרות וקו תחתון, מתחיל באות, באורך 2 עד 31.';
export const EXTERNAL_SECRET_KIND_INVALID = 'סוג הסוד אינו מוכר.';
export const EXTERNAL_SECRET_EMPTY = 'יש למלא ערך לסוד.';
export const EXTERNAL_SECRET_TOO_LONG = 'הערך ארוך מדי.';

/** Generous for an API key or a signing secret; anything longer is a paste gone wrong. */
const SECRET_MAX_CHARS = 4000;

/** The closed list of secret kinds, each the name of one `externalSecretRefs` field. */
const SECRET_KINDS: ReadonlyMap<string, 'key' | 'hook' | 'verify'> = new Map([
  ['key', 'key'],
  ['hook', 'hook'],
  ['verify', 'verify'],
] as const);

const SECRET_KIND_LABELS = { key: 'מפתח הגישה (API)', hook: 'סוד חתימת ההתראות', verify: 'אסימון האימות של ההתראות' } as const;

export interface ExternalRouteContext {
  req: IncomingMessage;
  method: string;
  pathname: string;
  staff: RecordingStaff;
  viewer: PanelViewer;
  /** The server's master key: secrets are sealed under it. */
  masterKey: Buffer;
  readForm(): Promise<URLSearchParams>;
  csrfOk(form: URLSearchParams): boolean;
  sendHtml(status: number, html: string): void;
  seeOther(location: string): void;
}

/** `/businesses/<id>/external[/<system>[/<action>]]`, or `null`. Ids are checked by the caller. */
function externalPath(pathname: string): { id: string; system: string | null; action: string | null } | null {
  const match = /^\/businesses\/([^/]+)\/external(?:\/([^/]+)(?:\/([a-z]+))?)?$/.exec(pathname);
  if (!match?.[1]) return null;
  return { id: match[1], system: match[2] ?? null, action: match[3] ?? null };
}

type Action = (ctx: ExternalRouteContext, businessId: string, systemId: string) => Promise<void>;

/** A `Map`, not an object: a path segment such as `constructor` is never an action. */
const ACTIONS: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['save', handleSave],
  ['delete', handleDelete],
  ['secret', handleSecret],
]);

/** Handles the request if it is one of these routes; `false` otherwise. */
export async function handleExternalRoute(ctx: ExternalRouteContext): Promise<boolean> {
  const target = externalPath(ctx.pathname);
  if (target === null) return false;
  if (!isValidBusinessId(target.id) || (target.system !== null && !EXTERNAL_SYSTEM_ID.test(target.system))) {
    ctx.sendHtml(404, renderNotFound());
    return true;
  }
  if (target.system === null) {
    if (ctx.method !== 'GET') return false;
    await showList(ctx, target.id);
    return true;
  }
  if (target.action === null) {
    if (ctx.method !== 'GET') return false;
    if ((await getBusiness(target.id)) === null) {
      ctx.sendHtml(404, renderNotFound());
      return true;
    }
    await showEditor(ctx, target.id, target.system, 200);
    return true;
  }
  const handler = ACTIONS.get(target.action);
  if (ctx.method !== 'POST' || handler === undefined) return false;
  await handler(ctx, target.id, target.system);
  return true;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

async function showList(ctx: ExternalRouteContext, businessId: string): Promise<void> {
  const detail = await businessDetailForPanel(businessId);
  if (detail === null) return ctx.sendHtml(404, renderNotFound());
  // "Open a system" is a GET form: `?system=<id>` goes to that system's editor.
  const requested = new URL(ctx.req.url ?? '/', 'http://admin.local').searchParams.get('system');
  let error: string | undefined;
  if (requested !== null) {
    const id = requested.trim();
    if (EXTERNAL_SYSTEM_ID.test(id)) return ctx.seeOther(`/businesses/${businessId}/external/${id}`);
    error = EXTERNAL_ID_INVALID;
  }
  const esc = escapeHtml;
  ctx.sendHtml(
    error === undefined ? 200 : 400,
    page(
      'מערכות חיצוניות',
      `<h1>מערכות חיצוניות · ${esc(detail.displayName)} <span class="muted">${esc(businessId)}</span></h1>
${error === undefined ? '' : `<p class="error">${esc(error)}</p>`}
<section class="card">
${renderExternalStatusTable(businessId, detail.externalSystems)}
</section>
<section class="card">
<h2>מערכת חדשה</h2>
<form method="get" action="/businesses/${esc(businessId)}/external">
  <label>מזהה המערכת<input type="text" name="system" required dir="ltr" placeholder="crm"></label>
  <button type="submit">פתיחת עורך</button>
</form>
</section>
<p><a href="/businesses/${esc(businessId)}">לדף העסק</a></p>`,
      ctx.viewer,
    ),
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/** A starting point for a new system: the id filled in, everything else to write. */
function blankTemplate(systemId: string): string {
  return JSON.stringify(
    {
      id: systemId,
      label: '',
      baseUrl: 'https://',
      auth: { kind: 'bearer' },
      idempotencyHeader: null,
      operations: [],
      webhook: null,
      scan: null,
    },
    null,
    2,
  );
}

interface EditorOptions {
  /** The text to put back in the editor after a refused save. */
  text?: string;
  /** Problems with the typed definition, one line each. */
  problems?: string[];
  error?: string;
}

async function showEditor(
  ctx: ExternalRouteContext,
  businessId: string,
  systemId: string,
  status: number,
  options: EditorOptions = {},
): Promise<void> {
  const detail = await businessDetailForPanel(businessId);
  if (detail === null) return ctx.sendHtml(404, renderNotFound());
  const systemStatus = detail.externalSystems.find((s) => s.systemId === systemId) ?? null;
  // The technician's own draft, on the business's connection under RLS.
  const draft = (await withBusiness(businessId, (db) => loadDrafts(db))).find((d) => d.systemId === systemId) ?? null;
  const text = options.text ?? (draft === null ? blankTemplate(systemId) : JSON.stringify(draft.definition, null, 2));
  const parsedDraft = draft === null ? null : ExternalSystem.safeParse(draft.definition);
  const preview = parsedDraft?.success === true ? describeExternalSystem(parsedDraft.data) : null;
  ctx.sendHtml(status, renderEditor(ctx.viewer, businessId, systemId, { text, systemStatus, hasDraft: draft !== null, preview, ...options }));
}

function renderEditor(
  viewer: PanelViewer,
  businessId: string,
  systemId: string,
  view: EditorOptions & {
    text: string;
    systemStatus: ExternalSystemPanelStatus | null;
    hasDraft: boolean;
    preview: string[] | null;
  },
): string {
  const esc = escapeHtml;
  const label = (value: string): string => esc(stripBidiControls(value));
  const base = `/businesses/${esc(businessId)}/external/${esc(systemId)}`;
  const csrf = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
  const s = view.systemStatus;
  const stateLine = s === null ? 'מצב: חדש — עדיין לא נשמר' : `מצב: ${EXTERNAL_STATE_LABELS[s.state]}`;
  const problems =
    view.problems === undefined || view.problems.length === 0
      ? ''
      : `<ul class="error">${view.problems.map((p) => `<li dir="auto">${label(p)}</li>`).join('\n')}</ul>`;
  const preview =
    view.preview === null
      ? ''
      : `<section class="card"><h2>תצוגה מקדימה של הטיוטה</h2><ul>${view.preview
          .map((line) => `<li>${label(line)}</li>`)
          .join('\n')}</ul></section>`;
  // The key is always asked for; the hook and verify secrets only where the definition needs them.
  const kinds: Array<'key' | 'hook' | 'verify'> = ['key'];
  if (s !== null && s.hookSaved !== null) kinds.push('hook');
  if (s !== null && s.verifySaved !== null) kinds.push('verify');
  const savedOf = { key: s?.keySaved ?? false, hook: s?.hookSaved ?? null, verify: s?.verifySaved ?? null };
  const secretForms = kinds
    .map(
      (kind) => `<form method="post" action="${base}/secret">
  ${csrf}
  <input type="hidden" name="kind" value="${kind}">
  <label>${esc(SECRET_KIND_LABELS[kind])} · ${secretCell(savedOf[kind])}<input type="password" name="value" autocomplete="off" required></label>
  <button type="submit">שמירה</button>
</form>`,
    )
    .join('\n');
  const deleteForm = view.hasDraft
    ? `<form method="post" action="${base}/delete">${csrf}<button type="submit">מחיקת הטיוטה</button></form>`
    : '';
  return page(
    `מערכת ${systemId}`,
    `<h1>מערכת <span dir="ltr">${esc(systemId)}</span></h1>
<p>${esc(stateLine)}</p>
${view.error === undefined ? '' : `<p class="error">${esc(view.error)}</p>`}
${problems}
<section class="card">
<h2>הגדרה (JSON)</h2>
<form method="post" action="${base}/save">
  ${csrf}
  <textarea name="definition" rows="24" dir="ltr" style="width:100%;box-sizing:border-box;font-family:monospace">${esc(view.text)}</textarea>
  <button type="submit">שמירת טיוטה</button>
</form>
${deleteForm}
<p class="muted">הטיוטה אינה פעילה. בעל העסק מאשר וחותם עליה בדשבורד שלו.</p>
</section>
${preview}
<section class="card">
<h2>סודות</h2>
${secretForms}
<p class="muted">ערך שנשמר לא יוצג שוב. שמירה חוזרת מחליפה אותו.</p>
</section>
<p><a href="/businesses/${esc(businessId)}/external">לכל המערכות</a></p>`,
    viewer,
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** CSRF, then the business must be registered. `false` when a response was already sent. */
async function admitted(ctx: ExternalRouteContext, form: URLSearchParams, businessId: string): Promise<boolean> {
  if (!ctx.csrfOk(form)) {
    ctx.sendHtml(403, renderForbidden());
    return false;
  }
  if ((await getBusiness(businessId)) === null) {
    ctx.sendHtml(404, renderNotFound());
    return false;
  }
  return true;
}

/** zod's issues as `path: message`, its own messages in Hebrew (the definition's custom ones as written). */
function issueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.length === 0 ? '(ההגדרה כולה)' : issue.path.join('.')}: ${issue.message}`);
}

async function handleSave(ctx: ExternalRouteContext, businessId: string, systemId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const text = form.get('definition') ?? '';
  const refuse = (options: EditorOptions): Promise<void> => showEditor(ctx, businessId, systemId, 400, { text, ...options });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse({ error: EXTERNAL_JSON_INVALID });
  }
  const parsed = ExternalSystem.safeParse(raw, { error: z.locales.he().localeError });
  if (!parsed.success) return refuse({ problems: issueLines(parsed.error) });
  if (parsed.data.id !== systemId) {
    return refuse({ error: `המזהה בהגדרה (${parsed.data.id}) אינו תואם למזהה בכתובת (${systemId}).` });
  }

  // The parsed form, defaults filled: what the owner will be shown and sign.
  await withBusiness(businessId, (db) =>
    saveDraft(db, { systemId, definition: parsed.data, staffId: ctx.staff.staffId }),
  );
  await recordStaffAction(ctx.staff, 'external_draft_saved', businessId, {
    operations: parsed.data.operations.length,
    webhook: parsed.data.webhook !== null,
    scan: parsed.data.scan !== null,
  });
  ctx.seeOther(`/businesses/${businessId}/external/${systemId}`);
}

async function handleDelete(ctx: ExternalRouteContext, businessId: string, systemId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  await withBusiness(businessId, (db) => deleteDraft(db, systemId));
  await recordStaffAction(ctx.staff, 'external_draft_deleted', businessId);
  ctx.seeOther(`/businesses/${businessId}/external/${systemId}`);
}

/**
 * One secret, sealed under the master key in the business's vault under the
 * derived ref. Allowed before and after signing: a secret is a connection,
 * not authority. The value is never echoed, logged or put in `detail`.
 */
async function handleSecret(ctx: ExternalRouteContext, businessId: string, systemId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const kind = SECRET_KINDS.get(form.get('kind') ?? '');
  if (kind === undefined) return showEditor(ctx, businessId, systemId, 400, { error: EXTERNAL_SECRET_KIND_INVALID });
  const value = (form.get('value') ?? '').trim();
  if (value === '') return showEditor(ctx, businessId, systemId, 400, { error: EXTERNAL_SECRET_EMPTY });
  if (value.length > SECRET_MAX_CHARS) return showEditor(ctx, businessId, systemId, 400, { error: EXTERNAL_SECRET_TOO_LONG });

  const ref = externalSecretRefs(systemId)[kind];
  await withBusiness(businessId, (db) =>
    putSecret(db, { ref, value, updatedBy: `staff:${ctx.staff.staffId}` }, ctx.masterKey),
  );
  await recordStaffAction(ctx.staff, 'external_secret_saved', businessId, { kind });
  ctx.seeOther(`/businesses/${businessId}/external/${systemId}`);
}
