/**
 * The panel's staff screens: the team list, add/remove/reset (head only), and
 * the activity log.
 *
 * **Authorisation is enforced here, on the server, before anything is read
 * from the form or written.** A non-head POST is a 403 whatever the form
 * says; `staffResetSecondFactor` has no check of its own (the store only
 * checks heads for invite and remove), so this route is its only gate. The
 * session's `isHead` is read from the member's row on every request
 * (`verifyStaffSession`).
 *
 * **What is logged is never who was invited.** `staff_invited`,
 * `staff_removed` and `totp_reset` carry no detail at all — no email, no
 * name — and no business (`null`). The log row is written only after the
 * action succeeded.
 *
 * **The invite link is the response to the POST that made it.** Only its
 * sha256 is stored, so no later page can show it again.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { recentStaffActions } from '../tenancy/activity-log.js';
import { inviteStaff, listStaff, removeStaff, staffResetSecondFactor, StaffError } from '../tenancy/staff.js';
import { recordStaffAction, type RecordingStaff } from './record.js';
import {
  renderActivityLog,
  renderForbidden,
  renderStaffPage,
  renderStaffRefused,
  STAFF_NOT_FOUND,
  type PanelViewer,
} from './views.js';

export interface StaffRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  staff: RecordingStaff;
  viewer: PanelViewer;
  /** The panel's public base URL for join links; `null` when unknown (see `adminBaseUrlFor`). */
  adminBaseUrl: string | null;
  readForm(): Promise<URLSearchParams>;
  csrfOk(form: URLSearchParams): boolean;
  sendHtml(status: number, html: string): void;
  seeOther(location: string): void;
}

const LOG_LIMIT = 200;
const FIELD_MAX = 200;

/** The invite link's origin is unknown: the head is told what to set. */
export const ADMIN_BASE_URL_MISSING =
  'לא ניתן להציג קישור הזמנה: כתובת הפאנל אינה מוגדרת. יש להגדיר את ADMIN_BASE_URL בשרת ולנסות שוב.';

/**
 * The panel's base URL for the link it shows. `ADMIN_BASE_URL` wins when set
 * (it must be an http(s) origin). Otherwise only a LOOPBACK Host is believed
 * (`localhost`, `127.0.0.1`, `[::1]`, with an optional port) and served as
 * http. Any other Host — a header the client sets — never becomes a link
 * origin: `null`, and the invite is refused (final review T11), because a
 * link minted on an attacker's Host sends the invitee's token to them.
 */
export function adminBaseUrlFor(
  req: IncomingMessage,
  env: string | undefined = process.env['ADMIN_BASE_URL'],
): string | null {
  if (env !== undefined && env.trim().length > 0) {
    try {
      const url = new URL(env.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Not a URL: fall through to the Host header.
    }
  }
  const host = req.headers.host ?? '';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host)) return `http://${host}`;
  return null;
}

/** `/staff/<id>/<action>`, or `null`. */
function staffActionPath(pathname: string): { id: string; action: string } | null {
  const match = /^\/staff\/([^/]+)\/(remove|reset-factor)$/.exec(pathname);
  return match?.[1] && match[2] ? { id: match[1], action: match[2] } : null;
}

export async function handleStaffRoute(ctx: StaffRouteContext): Promise<boolean> {
  const { method, pathname, viewer } = ctx;

  if (method === 'GET' && pathname === '/staff') {
    ctx.sendHtml(200, renderStaffPage(viewer, await listStaff()));
    return true;
  }
  if (method === 'GET' && pathname === '/log') {
    ctx.sendHtml(200, renderActivityLog(viewer, await recentStaffActions(LOG_LIMIT)));
    return true;
  }

  const isInvite = method === 'POST' && pathname === '/staff/invite';
  const target = method === 'POST' ? staffActionPath(pathname) : null;
  if (!isInvite && target === null) return false;

  // The gate: before the form is read and before anything is written.
  if (!viewer.isHead) {
    ctx.sendHtml(403, renderStaffRefused(viewer));
    return true;
  }
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) {
    ctx.sendHtml(403, renderForbidden());
    return true;
  }

  if (isInvite) {
    const name = (form.get('name') ?? '').trim().slice(0, FIELD_MAX);
    const email = (form.get('email') ?? '').trim().slice(0, FIELD_MAX);
    // Before anything is issued: a link with no trusted origin is never minted.
    if (ctx.adminBaseUrl === null) {
      ctx.sendHtml(400, renderStaffPage(viewer, await listStaff(), { error: ADMIN_BASE_URL_MISSING, values: { name, email } }));
      return true;
    }
    try {
      const { token } = await inviteStaff({ login: email, displayName: name, issuedBy: ctx.staff.staffId });
      await recordStaffAction(ctx.staff, 'staff_invited', null);
      ctx.sendHtml(200, renderStaffPage(viewer, await listStaff(), { inviteLink: `${ctx.adminBaseUrl}/join/${token}` }));
    } catch (err) {
      if (!(err instanceof StaffError)) throw err;
      ctx.sendHtml(400, renderStaffPage(viewer, await listStaff(), { error: err.message, values: { name, email } }));
    }
    return true;
  }

  const member = target ? (await listStaff()).find((s) => s.staffId === target.id) : undefined;
  if (!target || !member || member.removed) {
    ctx.sendHtml(404, renderStaffPage(viewer, await listStaff(), { error: STAFF_NOT_FOUND }));
    return true;
  }
  if (target.action === 'remove') {
    try {
      await removeStaff(target.id, { by: ctx.staff.staffId });
    } catch (err) {
      if (!(err instanceof StaffError)) throw err;
      ctx.sendHtml(400, renderStaffPage(viewer, await listStaff(), { error: err.message }));
      return true;
    }
    await recordStaffAction(ctx.staff, 'staff_removed', null);
  } else {
    await staffResetSecondFactor(target.id);
    await recordStaffAction(ctx.staff, 'totp_reset', null);
  }
  ctx.seeOther('/staff');
  return true;
}
