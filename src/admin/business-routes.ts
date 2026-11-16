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
import { ADDRESS_MAX_CHARS, ProfileValidationError, saveAddress, saveLogo } from '../business/profile.js';
import { LOGO_MAX_BYTES } from '../business/logo.js';
import { assertSetupUnlocked, saveSetupPackage, SetupLockedError, SetupPackage } from '../business/setup-package.js';
import type { BusinessDb } from '../db/pool.js';
import { putSecret } from '../governance/credential-store.js';
import { resetSecondFactor } from '../dashboard/second-factor.js';
import { saveRuntimeSettings } from '../tenancy/runtime-settings.js';
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
  renderResetIssued,
  renderUploadRefused,
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
export const SETUP_LOCKED = 'העסק כבר נחתם על ידי בעל העסק. מעכשיו רק הוא מעדכן את הפרטים האלה.';
export const LOGO_NOT_IMAGE = 'הקובץ אינו תמונת PNG או JPEG.';
export const LOGO_TOO_LARGE = 'הקובץ גדול מ-1MB.';
export const LOGO_MISSING = 'לא נבחר קובץ.';
export const UPLOAD_MALFORMED = 'לא הצלחתי לקרוא את הטופס.';
export const WHATSAPP_FIELDS_REQUIRED = 'יש למלא את מזהה החשבון ואת האסימון.';
export const WHATSAPP_FIELD_TOO_LONG = 'מזהה החשבון או האסימון ארוכים מדי.';
export const SETUP_ROW_INVALID = 'בכל שורה יש למלא שם, תפקיד וטלפון (עד 120 תווים לכל שדה).';
export const NO_OWNER_YET = 'לבעל העסק עדיין אין חשבון — שלח לו הזמנה במקום.';

/** The two refs the WhatsApp bridge resolves (`businessRuntime`) — fixed names. */
const WHATSAPP_REFS = { instanceId: 'GREEN_API_INSTANCE_ID', token: 'GREEN_API_TOKEN' } as const;
/** Generous for a GREEN-API id or token; anything longer is a paste gone wrong. */
const WHATSAPP_FIELD_MAX = 500;
/** The dashboard user an invite creates (`owner-links.ts`) — the business's owner. */
const OWNER_USERNAME = 'owner';

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
  /** The server's master key: the WhatsApp secrets are sealed under it. */
  masterKey: Buffer;
  /** Where business files live; the logo is written under it. */
  documentRoot: string;
  readForm(): Promise<URLSearchParams>;
  /** A multipart body with at most one file of at most `maxFileBytes`. */
  readUpload(maxFileBytes: number): Promise<UploadBody>;
  /** Whether the form's `csrf` field is bound to this session. */
  csrfOk(form: URLSearchParams): boolean;
  sendHtml(status: number, html: string): void;
  seeOther(location: string): void;
}

export type UploadBody =
  | { ok: true; form: URLSearchParams; file: Buffer | null }
  | { ok: false; code: 'too_large' | 'malformed' };

/** `/businesses/<id>[/<action>]`, or `null`. The id is checked later. */
function businessPath(pathname: string): { id: string; action: string | null } | null {
  const match = /^\/businesses\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (!match?.[1]) return null;
  return { id: match[1], action: match[2] ?? null };
}

function inviteUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/invite/${token}`;
}

function resetUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/reset/${token}`;
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
  const handler = target.action === null ? undefined : ACTIONS.get(target.action);
  if (handler === undefined) return false;
  await handler(ctx, target.id);
  return true;
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
  const currency = await charterCurrency(businessId);
  ctx.sendHtml(
    status,
    renderBusinessPage(ctx.viewer, detail, {
      setup,
      currency,
      dashboardBaseUrl: ctx.dashboardBaseUrl,
      ...(error ? { error } : {}),
    }),
  );
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

// ---------------------------------------------------------------------------
// Basic setup actions
// ---------------------------------------------------------------------------

type Action = (ctx: BusinessRouteContext, businessId: string) => Promise<void>;

/** A `Map`, not an object: a path segment such as `constructor` is never an action. */
const ACTIONS: ReadonlyMap<string, Action> = new Map<string, Action>([
  ['suspend', (ctx, id) => handleStatus(ctx, id, 'suspend')],
  ['resume', (ctx, id) => handleStatus(ctx, id, 'resume')],
  ['invite', (ctx, id) => handleInvite(ctx, id)],
  ['whatsapp', (ctx, id) => handleWhatsapp(ctx, id)],
  ['setup', (ctx, id) => handleSetup(ctx, id)],
  ['profile', (ctx, id) => handleProfile(ctx, id)],
  ['logo', (ctx, id) => handleLogo(ctx, id)],
  ['reset-link', (ctx, id) => handleResetLink(ctx, id)],
  ['totp-reset', (ctx, id) => handleTotpReset(ctx, id)],
]);

/** CSRF, then the business must be registered. `false` when a response was already sent. */
async function admitted(ctx: BusinessRouteContext, form: URLSearchParams, businessId: string): Promise<boolean> {
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

/**
 * The WhatsApp account's two secrets, sealed under the master key, and the
 * channel turned on — one business transaction. Allowed after handover: it
 * is a connection, not authority. The values are never echoed: the answer is
 * a redirect, the page shows only "saved", and the activity row carries no
 * detail.
 */
async function handleWhatsapp(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const instanceId = (form.get('instanceId') ?? '').trim();
  const token = (form.get('token') ?? '').trim();
  if (instanceId === '' || token === '') return showBusiness(ctx, businessId, 400, WHATSAPP_FIELDS_REQUIRED);
  if (instanceId.length > WHATSAPP_FIELD_MAX || token.length > WHATSAPP_FIELD_MAX) {
    return showBusiness(ctx, businessId, 400, WHATSAPP_FIELD_TOO_LONG);
  }
  const updatedBy = `staff:${ctx.staff.staffId}`;
  await withBusinessTransaction(businessId, async (tx) => {
    await putSecret(tx, { ref: WHATSAPP_REFS.instanceId, value: instanceId, updatedBy }, ctx.masterKey);
    await putSecret(tx, { ref: WHATSAPP_REFS.token, value: token, updatedBy }, ctx.masterKey);
    await saveRuntimeSettings(tx, { whatsappEnabled: true });
  });
  await recordStaffAction(ctx.staff, 'whatsapp_saved', businessId);
  ctx.seeOther(`/businesses/${businessId}`);
}

type PersonFields = Record<'name' | 'role' | 'phone', string>;

/** The rows of one repeatable group; a row left entirely blank is not a row. */
function personRows(form: URLSearchParams, prefix: 'contact' | 'colleague'): PersonFields[] {
  const names = form.getAll(`${prefix}_name`);
  const roles = form.getAll(`${prefix}_role`);
  const phones = form.getAll(`${prefix}_phone`);
  const count = Math.max(names.length, roles.length, phones.length);
  const rows: PersonFields[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = { name: names[i] ?? '', role: roles[i] ?? '', phone: phones[i] ?? '' };
    if (row.name.trim() === '' && row.role.trim() === '' && row.phone.trim() === '') continue;
    rows.push(row);
  }
  return rows;
}

/**
 * The boss number and the contacts and colleagues, replacing the package.
 * `saveSetupPackage` takes the install lock and re-checks the charter inside
 * it, so a tab left open across the owner's signature is refused (409) with
 * nothing written; the pre-check only makes that refusal win over a parse
 * error.
 */
async function handleSetup(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  if ((await setupDataForPanel(businessId)) === 'locked') return showBusiness(ctx, businessId, 409, SETUP_LOCKED);
  const boss = (form.get('boss') ?? '').trim();
  const parsed = SetupPackage.safeParse({
    bossWhatsapp: boss === '' ? null : boss,
    contacts: personRows(form, 'contact'),
    colleagues: personRows(form, 'colleague'),
  });
  if (!parsed.success) {
    // The phone parser's message is already Hebrew; every other issue is a row left half-filled or too long.
    const phone = parsed.error.issues.find((i) => i.code === 'custom');
    return showBusiness(ctx, businessId, 400, phone?.message ?? SETUP_ROW_INVALID);
  }
  try {
    await withBusiness(businessId, (db) => saveSetupPackage(db, parsed.data, `staff:${ctx.staff.staffId}`));
  } catch (err) {
    if (err instanceof SetupLockedError) return showBusiness(ctx, businessId, 409, SETUP_LOCKED);
    throw err;
  }
  await recordStaffAction(ctx.staff, 'setup_package_saved', businessId, {
    boss: parsed.data.bossWhatsapp !== null,
    contacts: parsed.data.contacts.length,
    colleagues: parsed.data.colleagues.length,
  });
  ctx.seeOther(`/businesses/${businessId}`);
}

/**
 * Run `write` in one business transaction that first takes the charter
 * install lock and re-checks the charter (`assertSetupUnlocked`) — the lock
 * `saveSetupPackage` and the interview's install take — so the check and the
 * write cannot straddle a signature. `'locked'` when a charter is active.
 */
async function writeWhileUnsigned<T>(businessId: string, write: (tx: BusinessDb) => Promise<T>): Promise<T | 'locked'> {
  try {
    return await withBusinessTransaction(businessId, async (tx) => {
      await assertSetupUnlocked(tx);
      return write(tx);
    });
  } catch (err) {
    if (err instanceof SetupLockedError) return 'locked';
    throw err;
  }
}

async function handleProfile(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const address = form.get('address') ?? '';
  let outcome: 'ok' | 'locked';
  try {
    outcome = await writeWhileUnsigned(businessId, async (tx) => {
      await saveAddress(tx, address, `staff:${ctx.staff.staffId}`);
      return 'ok' as const;
    });
  } catch (err) {
    if (err instanceof ProfileValidationError) return showBusiness(ctx, businessId, 400, err.message);
    throw err;
  }
  if (outcome === 'locked') return showBusiness(ctx, businessId, 409, SETUP_LOCKED);
  await recordStaffAction(ctx.staff, 'profile_saved', businessId, { address: address.trim() !== '' });
  ctx.seeOther(`/businesses/${businessId}`);
}

/**
 * The logo, judged by its bytes (`saveLogo`). It is written inside the
 * transaction that holds the install lock, so a refused upload leaves nothing
 * on disk either.
 */
async function handleLogo(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const body = await ctx.readUpload(LOGO_MAX_BYTES);
  if (!body.ok) {
    // Refused before the CSRF field could be read: a page with the refusal only, no business data.
    return body.code === 'too_large'
      ? ctx.sendHtml(413, renderUploadRefused(ctx.viewer, businessId, LOGO_TOO_LARGE))
      : ctx.sendHtml(400, renderUploadRefused(ctx.viewer, businessId, UPLOAD_MALFORMED));
  }
  if (!(await admitted(ctx, body.form, businessId))) return;
  const bytes = body.file;
  if (bytes === null) return showBusiness(ctx, businessId, 400, LOGO_MISSING);
  const outcome = await writeWhileUnsigned(businessId, (tx) =>
    saveLogo(tx, bytes, ctx.documentRoot, `staff:${ctx.staff.staffId}`),
  );
  if (outcome === 'locked') return showBusiness(ctx, businessId, 409, SETUP_LOCKED);
  if (outcome === 'not_image') return showBusiness(ctx, businessId, 400, LOGO_NOT_IMAGE);
  if (outcome === 'too_large') return showBusiness(ctx, businessId, 413, LOGO_TOO_LARGE);
  await recordStaffAction(ctx.staff, 'logo_saved', businessId);
  ctx.seeOther(`/businesses/${businessId}`);
}

/** The owner's sign-in address, from the business's own data; `null` while there is no owner. */
async function ownerLoginOf(db: BusinessDb): Promise<string | null> {
  const { rows } = await db.query<{ login: string }>(
    'SELECT login FROM dashboard_users WHERE business_id = $1 AND username = $2',
    [db.businessId, OWNER_USERNAME],
  );
  return rows[0]?.login ?? null;
}

/**
 * A password-reset link for the owner's own login, shown once — the body of
 * this POST, like the invite; only its sha256 is stored, and neither the log
 * nor the activity row carries it. No owner yet: refused, the invite form
 * covers that case.
 */
async function handleResetLink(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const token = await withBusinessTransaction(businessId, async (tx) => {
    const login = await ownerLoginOf(tx);
    if (login === null) return null;
    return issueOwnerLink(tx, { kind: 'password_reset', login, issuedBy: `staff:${ctx.staff.staffId}` });
  });
  if (token === null) return showBusiness(ctx, businessId, 409, NO_OWNER_YET);
  await recordStaffAction(ctx.staff, 'reset_issued', businessId);
  ctx.sendHtml(200, renderResetIssued(ctx.viewer, { businessId, link: resetUrl(ctx.dashboardBaseUrl, token) }));
}

/** Forget the owner's Authenticator: every session and trusted device goes, and the next sign-in enrols again. */
async function handleTotpReset(ctx: BusinessRouteContext, businessId: string): Promise<void> {
  const form = await ctx.readForm();
  if (!(await admitted(ctx, form, businessId))) return;
  const done = await withBusinessTransaction(businessId, async (tx) => {
    if ((await ownerLoginOf(tx)) === null) return false;
    await resetSecondFactor(tx, OWNER_USERNAME);
    return true;
  });
  if (!done) return showBusiness(ctx, businessId, 409, NO_OWNER_YET);
  await recordStaffAction(ctx.staff, 'totp_reset', businessId);
  ctx.seeOther(`/businesses/${businessId}`);
}
