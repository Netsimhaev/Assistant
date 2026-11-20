/**
 * Deleting a whole business from the panel (spec
 * docs/superpowers/specs/2026-11-19-business-deletion-design.md):
 *
 * - `GET  /businesses/:id/delete`        the confirmation page (a suspended
 *                                        business) or the retry (one being deleted)
 * - `POST /businesses/:id/delete`        revoke Google, delete the rows, the
 *                                        files, then the registry row
 * - `POST /businesses/:id/delete/files`  retry the file step and the registry row
 *
 * **Head only, checked before the form is read.** Every POST also carries the
 * session's CSRF token. The tenancy functions re-check head and status
 * themselves, under lock where it matters; the checks here only decide what
 * the head admin reads.
 *
 * **A typo must not revoke the customer's Google access.** Revocation comes
 * before the rows go and is not undone, so the typed name (`namesMatch`, the
 * same rule `deleteBusinessRows` applies under lock) and a pass in flight are
 * checked first, and either refusal calls no provider.
 *
 * **Nothing is recorded** — no activity-log row, no audit row (owner ruling):
 * the business's own trail is one of the things deleted. The result page
 * carries counts only, never the business's name, and is not persisted.
 */
import { config } from '../config.js';
import { isValidBusinessId } from '../db/pool.js';
import {
  DELETION_REFUSAL_HE,
  deleteBusinessFiles,
  deleteBusinessRows,
  FILE_DELETION_REFUSAL_HE,
  finishDeletion,
  namesMatch,
  passInFlight,
  revokeBusinessGrants,
  type DeleteFilesTestSeam,
} from '../tenancy/business-deletion.js';
import { getBusiness } from '../tenancy/businesses.js';
import type { RecordingStaff } from './record.js';
import {
  renderDeleteConfirm,
  renderDeleteRefused,
  renderDeletingNotice,
  renderDeletionResult,
  renderForbidden,
  type PanelViewer,
} from './views.js';

/** Test-only hooks; production leaves them unset (and outside tests they are ignored). */
export interface DeletionTestSeams {
  fetchImpl?: typeof fetch;
  rm?: DeleteFilesTestSeam['rm'];
}

export interface DeletionRouteContext {
  method: string;
  pathname: string;
  staff: RecordingStaff;
  viewer: PanelViewer;
  /** The server's master key: the grants' refresh tokens are sealed under it. */
  masterKey: Buffer;
  testSeams?: DeletionTestSeams;
  readForm(): Promise<URLSearchParams>;
  csrfOk(form: URLSearchParams): boolean;
  sendHtml(status: number, html: string): void;
}

/** `/businesses/<id>/delete[/files]`, or `null`. */
function deletionPath(pathname: string): { id: string; files: boolean } | null {
  const match = /^\/businesses\/([^/]+)\/delete(\/files)?$/.exec(pathname);
  if (!match?.[1]) return null;
  return { id: match[1], files: match[2] !== undefined };
}

/** Handles the request if it is one of these routes; `false` otherwise. */
export async function handleDeletionRoute(ctx: DeletionRouteContext): Promise<boolean> {
  const target = deletionPath(ctx.pathname);
  if (target === null) return false;
  if (target.files ? ctx.method !== 'POST' : ctx.method !== 'GET' && ctx.method !== 'POST') return false;

  // The gate: before the form is read and before anything is looked up.
  if (!ctx.viewer.isHead) {
    ctx.sendHtml(403, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.not_head));
    return true;
  }
  if (!isValidBusinessId(target.id)) {
    ctx.sendHtml(404, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.unknown_business));
    return true;
  }
  if (ctx.method === 'GET') await showDelete(ctx, target.id);
  else if (target.files) await handleRetry(ctx, target.id);
  else await handleDelete(ctx, target.id);
  return true;
}

async function showDelete(ctx: DeletionRouteContext, businessId: string): Promise<void> {
  const biz = await getBusiness(businessId);
  if (biz === null) return ctx.sendHtml(404, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.unknown_business));
  if (biz.status === 'deleting') return ctx.sendHtml(200, renderDeletingNotice(ctx.viewer, businessId));
  if (biz.status !== 'suspended') {
    return ctx.sendHtml(409, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.not_suspended));
  }
  ctx.sendHtml(200, renderDeleteConfirm(ctx.viewer, { businessId, displayName: biz.displayName }));
}

function seams(ctx: DeletionRouteContext): DeletionTestSeams {
  return config.isTest ? (ctx.testSeams ?? {}) : {};
}

async function handleDelete(ctx: DeletionRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) return ctx.sendHtml(403, renderForbidden());

  const biz = await getBusiness(businessId);
  if (biz === null) return ctx.sendHtml(404, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.unknown_business));
  if (biz.status === 'deleting') return ctx.sendHtml(409, renderDeletingNotice(ctx.viewer, businessId));
  if (biz.status !== 'suspended') {
    return ctx.sendHtml(409, renderDeleteRefused(ctx.viewer, DELETION_REFUSAL_HE.not_suspended));
  }
  const again = (status: number, error: string): void =>
    ctx.sendHtml(status, renderDeleteConfirm(ctx.viewer, { businessId, displayName: biz.displayName, error }));

  // Before anything is revoked: a typo or a running pass calls no provider.
  const typedName = form.get('name') ?? '';
  if (!namesMatch(typedName, biz.displayName)) return again(400, DELETION_REFUSAL_HE.name_mismatch);
  if (await passInFlight(businessId)) return again(409, DELETION_REFUSAL_HE.pass_in_flight);

  const s = seams(ctx);
  const revocation = await revokeBusinessGrants(
    { businessId, staffId: ctx.staff.staffId, key: ctx.masterKey },
    s.fetchImpl !== undefined ? { fetchImpl: s.fetchImpl } : {},
  );
  if (!revocation.ok) return refusal(ctx, businessId, biz.displayName, revocation.refusal);

  const rows = await deleteBusinessRows({ businessId, staffId: ctx.staff.staffId, typedName });
  if (!rows.ok) return refusal(ctx, businessId, biz.displayName, rows.refusal);

  await finishFiles(ctx, businessId, {
    rowsDeleted: rows.tables.reduce((sum, t) => sum + t.deleted, 0),
    revocation: { attempted: revocation.attempted, failed: revocation.failed, grantsUnreadable: revocation.grantsUnreadable },
  });
}

/** A refusal from a tenancy step: the confirmation again where it can still succeed, a bare message otherwise. */
function refusal(
  ctx: DeletionRouteContext,
  businessId: string,
  displayName: string,
  code: keyof typeof DELETION_REFUSAL_HE,
): void {
  const message = DELETION_REFUSAL_HE[code];
  if (code === 'name_mismatch' || code === 'pass_in_flight') {
    return ctx.sendHtml(code === 'name_mismatch' ? 400 : 409, renderDeleteConfirm(ctx.viewer, { businessId, displayName, error: message }));
  }
  const status = code === 'not_head' ? 403 : code === 'unknown_business' ? 404 : 409;
  ctx.sendHtml(status, renderDeleteRefused(ctx.viewer, message));
}

async function handleRetry(ctx: DeletionRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) return ctx.sendHtml(403, renderForbidden());
  await finishFiles(ctx, businessId, {});
}

/** The file step and the registry row, then the result page. */
async function finishFiles(
  ctx: DeletionRouteContext,
  businessId: string,
  extra: { rowsDeleted?: number; revocation?: { attempted: number; failed: number; grantsUnreadable: boolean } },
): Promise<void> {
  const s = seams(ctx);
  const files = await deleteBusinessFiles(businessId, s.rm !== undefined ? { rm: s.rm } : undefined);
  if (!files.ok) return ctx.sendHtml(409, renderDeleteRefused(ctx.viewer, FILE_DELETION_REFUSAL_HE[files.refusal]));
  const finished = await finishDeletion(businessId);
  ctx.sendHtml(
    200,
    renderDeletionResult(ctx.viewer, {
      businessId,
      filesRemoved: files.removed,
      failed: files.failed,
      finished,
      ...(extra.rowsDeleted !== undefined ? { rowsDeleted: extra.rowsDeleted } : {}),
      ...(extra.revocation !== undefined ? { revocation: extra.revocation } : {}),
    }),
  );
}
