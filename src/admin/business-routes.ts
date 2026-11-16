/**
 * The panel's business screens: the list, opening a new business, the
 * business page with its snapshot, suspend/resume, and a fresh owner invite.
 *
 * **What these screens may show** (global constraints): states, counts, and
 * what a technician typed — never business content. The list and the page
 * read only `listBusinessesForPanel`/`businessDetailForPanel`, which select no
 * content column; the typed address comes from `setupDataForPanel`, which
 * answers `'locked'` once the owner signed. The one thing read here on a
 * business's own connection is the charter's currency code, for the cost.
 *
 * **Platform data only through `src/tenancy/`; business data only through
 * `withBusiness`.** Every action is recorded through `recordStaffAction`, and
 * only that.
 *
 * **The invite link is shown once.** It is the body of the POST response that
 * issued it. Only its sha256 is stored (`owner_links`), so no later page can
 * show it again; a browser refresh re-POSTs the form, which is refused
 * because the business now exists, and issues nothing.
 *
 * **Opening is two steps that cannot share a transaction** — the registry row
 * on the platform pool, then the address and the invite in the business's own
 * transaction. If the second fails, the business exists without an invite:
 * the technician is told so on the spot, the action is logged with
 * `invite: false`, and the business page offers "send a new invite" for as
 * long as the business has no owner. That form is also how a mistyped
 * address is corrected: a new invite retires every unused one first.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidBusinessId, RESERVED_BUSINESS_IDS, withBusiness, withBusinessTransaction } from '../db/pool.js';
import { ADDRESS_MAX_CHARS, saveAddress } from '../business/profile.js';
import { issueOwnerLink, retireUnusedOwnerLinks } from '../dashboard/owner-links.js';
import { EMAIL_SHAPE } from '../governance/typed-recipients.js';
import {
  BusinessExistsError,
  createBusiness,
  getBusiness,
  setBusinessStatus,
  TenancyError,
} from '../tenancy/businesses.js';
import { normaliseLogin } from '../tenancy/login.js';
import { businessDetailForPanel, listBusinessesForPanel, setupDataForPanel } from '../tenancy/panel-reads.js';
import { resolveLogin } from '../tenancy/platform.js';
import { recordStaffAction, type RecordingStaff } from './record.js';
import {
  renderBusinessList,
  renderBusinessPage,
  renderForbidden,
  renderInviteIssued,
  renderNewBusiness,
  renderNotFound,
  renderOpenedWithoutInvite,
  type NewBusinessValues,
  type PanelViewer,
} from './views.js';

export const BUSINESS_ID_INVALID =
  'מזהה עסק לא תקין — אותיות אנגליות קטנות, ספרות ומקפים בלבד, באורך 3 עד 63.';
export const BUSINESS_ID_RESERVED = 'המזהה הזה שמור לשימוש המערכת — בחר מזהה אחר לעסק.';
export const BUSINESS_EXISTS = 'כבר קיים עסק עם המזהה הזה.';
export const BUSINESS_NAME_INVALID = 'שם העסק חייב להכיל בין 1 ל-120 תווים.';
export const OWNER_EMAIL_INVALID = 'כתובת המייל אינה תקינה.';
export const OWNER_EMAIL_TAKEN = 'כתובת המייל הזאת כבר משמשת לכניסה של עסק אחר.';
export const ADDRESS_TOO_LONG = `הכתובת ארוכה מדי — עד ${ADDRESS_MAX_CHARS} תווים.`;
export const OWNER_ALREADY_EXISTS = 'לבעל העסק כבר יש חשבון — אין צורך בהזמנה.';

const BUSINESS_NAME_MAX = 120;

/**
 * Literal path segments the panel routes under `/businesses/`. A business
 * with one of these ids could never be reached — `/businesses/new` always
 * renders the open form — so the open form refuses them as reserved.
 */
export const PANEL_RESERVED_IDS: ReadonlySet<string> = new Set(['new']);

/** What the server hands each route: the request, the signed-in member, and the response helpers. */
export interface BusinessRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  staff: RecordingStaff;
  viewer: PanelViewer;
  /** The owner dashboard's public base URL, where invite links point. */
  dashboardBaseUrl: string;
  readForm(): Promise<URLSearchParams>;
  /** Whether the form's `csrf` field is bound to this session. */
  csrfOk(form: URLSearchParams): boolean;
  sendHtml(status: number, html: string): void;
  seeOther(location: string): void;
}

/** `/businesses/<id>[/<action>]`, or `null`. The id is checked later. */
function businessPath(pathname: string): { id: string; action: string | null } | null {
  const match = /^\/businesses\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (!match?.[1]) return null;
  return { id: match[1], action: match[2] ?? null };
}

function inviteUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/invite/${token}`;
}

/**
 * Handles the request if it is one of these routes; `false` otherwise (the
 * server then answers 404).
 */
export async function handleBusinessRoute(ctx: BusinessRouteContext): Promise<boolean> {
  const { method, pathname } = ctx;
  if (pathname === '/') {
    if (method !== 'GET') return false;
    ctx.sendHtml(200, renderBusinessList(ctx.viewer, await listBusinessesForPanel()));
    return true;
  }
  if (pathname === '/businesses/new') {
    if (method === 'GET') {
      ctx.sendHtml(200, renderNewBusiness(ctx.viewer));
      return true;
    }
    if (method === 'POST') {
      await handleOpen(ctx);
      return true;
    }
    return false;
  }
  const target = businessPath(pathname);
  if (target === null) return false;
  if (!isValidBusinessId(target.id)) {
    ctx.sendHtml(404, renderNotFound());
    return true;
  }
  if (target.action === null && method === 'GET') {
    await showBusiness(ctx, target.id, 200);
    return true;
  }
  if (method !== 'POST') return false;
  if (target.action === 'suspend' || target.action === 'resume') {
    await handleStatus(ctx, target.id, target.action);
    return true;
  }
  if (target.action === 'invite') {
    await handleInvite(ctx, target.id);
    return true;
  }
  return false;
}

/** The active charter's currency code, or `null` without a charter (or one not shaped as expected). */
async function charterCurrency(businessId: string): Promise<string | null> {
  const { rows } = await withBusiness(businessId, (db) =>
    db.query<{ currency: string | null }>(
      `SELECT v.policy_bundle -> 'ceilings' ->> 'currency' AS currency
         FROM charter_active a
         JOIN charter_versions v ON v.charter_version = a.charter_version AND v.business_id = a.business_id
        WHERE a.business_id = $1`,
      [businessId],
    ),
  );
  const currency = rows[0]?.currency ?? null;
  return currency !== null && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

async function showBusiness(ctx: BusinessRouteContext, businessId: string, status: number, error?: string): Promise<void> {
  const detail = await businessDetailForPanel(businessId);
  if (detail === null) return ctx.sendHtml(404, renderNotFound());
  const setup = await setupDataForPanel(businessId);
  const address = setup === 'locked' ? 'locked' : setup.address;
  const currency = await charterCurrency(businessId);
  ctx.sendHtml(status, renderBusinessPage(ctx.viewer, detail, { address, currency, ...(error ? { error } : {}) }));
}

/** The first refusal for a typed owner login, or `null` when it may be invited. */
async function ownerEmailProblem(email: string): Promise<string | null> {
  const login = normaliseLogin(email);
  if (!EMAIL_SHAPE.test(login)) return OWNER_EMAIL_INVALID;
  if ((await resolveLogin(login)) !== null) return OWNER_EMAIL_TAKEN;
  return null;
}

/**
 * In one business transaction: save the address (when given), retire every
 * unused invite of the business, and issue one for `login`.
 */
async function issueInvite(businessId: string, login: string, staff: RecordingStaff, address?: string): Promise<string> {
  return withBusinessTransaction(businessId, async (tx) => {
    if (address !== undefined && address.trim() !== '') await saveAddress(tx, address, `staff:${staff.staffId}`);
    await retireUnusedOwnerLinks(tx, 'invite');
    return issueOwnerLink(tx, { kind: 'invite', login, issuedBy: `staff:${staff.staffId}` });
  });
}

async function handleOpen(ctx: BusinessRouteContext): Promise<void> {
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) return ctx.sendHtml(403, renderForbidden());
  const values: NewBusinessValues = {
    id: (form.get('id') ?? '').trim(),
    name: (form.get('name') ?? '').trim(),
    email: (form.get('email') ?? '').trim(),
    address: (form.get('address') ?? '').trim(),
  };
  const refuse = (error: string): void => ctx.sendHtml(400, renderNewBusiness(ctx.viewer, { values, error }));

  // Everything is checked before anything is written.
  if (RESERVED_BUSINESS_IDS.has(values.id) || PANEL_RESERVED_IDS.has(values.id)) return refuse(BUSINESS_ID_RESERVED);
  if (!isValidBusinessId(values.id)) return refuse(BUSINESS_ID_INVALID);
  if (values.name.length === 0 || values.name.length > BUSINESS_NAME_MAX) return refuse(BUSINESS_NAME_INVALID);
  if (values.address.length > ADDRESS_MAX_CHARS) return refuse(ADDRESS_TOO_LONG);
  const emailProblem = await ownerEmailProblem(values.email);
  if (emailProblem !== null) return refuse(emailProblem);
  if ((await getBusiness(values.id)) !== null) return refuse(BUSINESS_EXISTS);

  let warning: string | undefined;
  try {
    await createBusiness(values.id, values.name);
  } catch (err) {
    // Another open of the same id won the race between our check and our
    // insert: the business is someone else's. Refuse — nothing issued,
    // nothing logged, and the winner's invite stays live. Never fall through
    // to the invite, which would retire it and invite our address instead.
    if (err instanceof BusinessExistsError) return refuse(BUSINESS_EXISTS);
    if (!(err instanceof TenancyError)) throw err;
    // Any other refusal: one raised before the row leaves nothing behind; one
    // raised after it (the server save folder) leaves a business that works
    // except for saving, and is said out loud.
    if ((await getBusiness(values.id)) === null) return refuse(err.message);
    warning = err.message;
  }

  let token: string;
  try {
    token = await issueInvite(values.id, normaliseLogin(values.email), ctx.staff, values.address);
  } catch (err) {
    console.error('panel: invite after opening failed:', err instanceof Error ? err.message : err);
    await recordStaffAction(ctx.staff, 'business_open', values.id, { invite: false });
    return ctx.sendHtml(500, renderOpenedWithoutInvite(ctx.viewer, values.id));
  }
  await recordStaffAction(ctx.staff, 'business_open', values.id, {
    invite: true,
    address: values.address !== '',
  });
  ctx.sendHtml(
    200,
    renderInviteIssued(ctx.viewer, {
      businessId: values.id,
      heading: 'העסק נפתח',
      link: inviteUrl(ctx.dashboardBaseUrl, token),
      ...(warning !== undefined ? { warning } : {}),
    }),
  );
}

async function handleInvite(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) return ctx.sendHtml(403, renderForbidden());
  const detail = await businessDetailForPanel(businessId);
  if (detail === null) return ctx.sendHtml(404, renderNotFound());
  if (detail.ownerExists) return showBusiness(ctx, businessId, 409, OWNER_ALREADY_EXISTS);
  const email = form.get('email') ?? '';
  const problem = await ownerEmailProblem(email);
  if (problem !== null) return showBusiness(ctx, businessId, 400, problem);

  const token = await issueInvite(businessId, normaliseLogin(email), ctx.staff);
  await recordStaffAction(ctx.staff, 'invite_issued', businessId);
  ctx.sendHtml(
    200,
    renderInviteIssued(ctx.viewer, {
      businessId,
      heading: 'הזמנה חדשה לבעל העסק',
      link: inviteUrl(ctx.dashboardBaseUrl, token),
    }),
  );
}

async function handleStatus(ctx: BusinessRouteContext, businessId: string, action: 'suspend' | 'resume'): Promise<void> {
  const form = await ctx.readForm();
  if (!ctx.csrfOk(form)) return ctx.sendHtml(403, renderForbidden());
  if ((await getBusiness(businessId)) === null) return ctx.sendHtml(404, renderNotFound());
  await setBusinessStatus(businessId, action === 'suspend' ? 'suspended' : 'active');
  await recordStaffAction(ctx.staff, action === 'suspend' ? 'business_suspend' : 'business_resume', businessId);
  ctx.seeOther(`/businesses/${businessId}`);
}
