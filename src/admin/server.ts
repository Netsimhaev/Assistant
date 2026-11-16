/**
 * The operator panel — a separate HTTP server from the owner's dashboard,
 * where the company's technicians (platform staff) sign in with a password
 * and Google Authenticator. Later tasks add the business screens onto it.
 *
 * **Separate in every way the owner's dashboard is, on purpose.** Its own
 * port, its own cookie names (`asid`, `adev` — never `sid`/`tdev`), its own
 * session table (`platform_staff_sessions`), its own unknown-login bucket
 * (migration 074). An owner's cookie is nobody here and a technician's cookie
 * is nobody there (`isolation.test.ts`).
 *
 * **It reaches platform data only through `src/tenancy/`.** This directory is
 * not on the platform-pool import allowlist (`platform-imports.test.ts`):
 * every staff read and write is a named function in `tenancy/staff.ts`, which
 * opens `withPlatform` itself.
 *
 * **The sign-in flow mirrors the owner's (dashboard `server.ts`):**
 * - a session is minted owing its factor — enrolment for a member who never
 *   enrolled, nothing on a device this member trusts, a code otherwise;
 * - enrolled-or-not is re-read on every request, so a session whose member is
 *   not enrolled (whatever its `pending_factor` says) reaches only enrolment;
 * - when the factor settles the session token is ROTATED, never upgraded in
 *   place, and the browser becomes a trusted device (`adev`);
 * - every POST past login carries a CSRF token bound to the `asid` value.
 *
 * Cookies are `SameSite=Strict`, unlike the dashboard's `Lax`: the panel has
 * no OAuth callback that a cross-site navigation must carry a session to.
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { issueCsrfToken, verifyCsrfToken } from '../dashboard/csrf.js';
import { ADMIN_BIND, assertBindableHost } from '../util/bind.js';
import { otpauthUri } from '../auth/totp.js';
import { qrSvg } from '../auth/qr.js';
import { MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { SESSION_HOURS, TRUSTED_DEVICE_DAYS } from '../auth/lifetimes.js';
import {
  isStaffDevice,
  issueStaffDevice,
  listStaff,
  redeemStaffLink,
  revokeStaffSession,
  rotateStaffSession,
  staffBeginEnrolment,
  staffConfirmEnrolment,
  staffLogin,
  staffTotpStatus,
  StaffTotpAlreadyEnrolledError,
  staffVerifySecondFactor,
  startStaffSession,
  verifyStaffSession,
  type StaffPendingFactor,
  type StaffSession,
} from '../tenancy/staff.js';
import {
  JOIN_LINK_INVALID,
  JOIN_LOGIN_MISMATCH,
  JOIN_PASSWORDS_DIFFER,
  PANEL_LOGIN_FAILED,
  PANEL_LOGIN_LOCKED,
  renderForbidden,
  renderHome,
  renderJoin,
  renderLogin,
  renderNotFound,
  renderServerError,
  renderTooLarge,
  renderTotpEnrol,
  renderTotpVerify,
  TOTP_BAD_CODE,
  TOTP_LOCKED,
  type PanelViewer,
} from './views.js';

export interface AdminOptions {
  /** Loopback by default; anything else is refused unless `allowNonLoopbackBind`. */
  host?: string;
  /** 0 lets the OS pick a free port; tests always pass 0. */
  port?: number;
  /**
   * Whether `X-Forwarded-For` may be believed. Off unless the only route to
   * this port is a proxy that writes it. Nothing reads it yet; kept for the
   * activity trail, the dashboard's option in the same shape.
   */
  trustProxy?: boolean;
  allowNonLoopbackBind?: boolean;
  /** The server's master key: the staff second factor is sealed under it. */
  masterKey: Buffer;
  /** Where business files live (the logo, Task 10). */
  documentRoot: string;
  /** The owner dashboard's public base URL, for the links the panel shows (Task 10). */
  dashboardBaseUrl: string;
}

const SESSION_COOKIE = 'asid';
const DEVICE_COOKIE = 'adev';
const SESSION_MAX_AGE_SECONDS = SESSION_HOURS * 3600;
const DEVICE_MAX_AGE_SECONDS = TRUSTED_DEVICE_DAYS * 86_400;
const TOTP_ISSUER = 'העוזרת — צוות';
const MAX_BODY_BYTES = 64 * 1024;
/** A staff session, device and invite token: 32 random bytes in hex. */
const RAW_TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Sent on every response, redirects included. `Referrer-Policy` because the
 * invite link carries its token in the path; the CSP allows no script at all
 * and inline style only, and `form-action 'self'` keeps every form here.
 */
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
} as const;

function sendHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function seeOther(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { Location: location, ...SECURITY_HEADERS, ...headers });
  res.end();
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DEVICE_MAX_AGE_SECONDS}`;
}

/** Cookie pairs; a malformed `%` escape skips the pair (never a 500). */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key.length === 0) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      continue;
    }
  }
  return out;
}

/** The raw token a cookie carries, or `null` for none or one of the wrong shape. */
function tokenCookie(req: IncomingMessage, name: string): string | null {
  const value = parseCookies(req.headers.cookie)[name];
  return value !== undefined && RAW_TOKEN_SHAPE.test(value) ? value : null;
}

class FormBodyTooLargeError extends Error {}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new FormBodyTooLargeError('form body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A signed-in request: the raw token, the CSRF binding and what the session row says. */
interface PanelSession extends StaffSession {
  token: string;
}

function viewerOf(session: PanelSession): PanelViewer {
  return { displayName: session.displayName, isHead: session.isHead, csrf: issueCsrfToken(session.token) };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * No CSRF on the login form, as on the dashboard's: there is no session to
 * bind a token to, and no self-registration — making this form succeed
 * already requires the member's password.
 */
async function handleLoginPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readFormBody(req);
  const email = form.get('email') ?? '';
  const password = form.get('password') ?? '';
  if (password.length === 0) return sendHtml(res, 401, renderLogin({ error: PANEL_LOGIN_FAILED }));

  const result = await staffLogin({ login: email, password });
  if (!result.ok) {
    return sendHtml(res, 401, renderLogin({ error: result.code === 'locked' ? PANEL_LOGIN_LOCKED : PANEL_LOGIN_FAILED }));
  }
  const owed = await factorAtLogin(result.staffId, tokenCookie(req, DEVICE_COOKIE));
  const token = await startStaffSession(result.staffId, { pendingFactor: owed });
  seeOther(res, screenFor(owed) ?? '/', { 'Set-Cookie': sessionCookie(token) });
}

/**
 * The factor a fresh session owes: enrolment for a member who never enrolled
 * (whatever device they are on), nothing on a device this member trusts, a
 * code otherwise.
 */
async function factorAtLogin(staffId: string, device: string | null): Promise<StaffPendingFactor | null> {
  if ((await staffTotpStatus(staffId)) === 'not_enrolled') return 'enroll';
  if (device !== null && (await isStaffDevice(staffId, device))) return null;
  return 'verify';
}

function screenFor(owed: StaffPendingFactor | null): '/2fa' | '/2fa/enrol' | null {
  return owed === 'enroll' ? '/2fa/enrol' : owed === 'verify' ? '/2fa' : null;
}

/**
 * Where a session that still owes its factor must go, or `null`. Enrolment is
 * read from the member's row on every request, not trusted from the session:
 * a session that says it owes nothing, for a member who is not enrolled (a
 * reset in between, or a session minted before), still goes to enrolment.
 */
async function screenForSession(session: PanelSession): Promise<'/2fa' | '/2fa/enrol' | null> {
  const enrolled = (await staffTotpStatus(session.staffId)) === 'enrolled';
  if (session.pendingFactor === null && enrolled) return null;
  return enrolled ? '/2fa' : '/2fa/enrol';
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

/**
 * The factor is settled: the session is replaced (`rotateStaffSession`, one
 * transaction — the pre-factor token is revoked and a fresh one minted), and
 * this browser becomes a trusted device. A token that was planted or seen
 * before the factor never becomes a full session.
 */
async function finishSecondFactor(res: ServerResponse, session: PanelSession): Promise<void> {
  const fresh = await rotateStaffSession(session.token, { pendingFactor: null });
  if (fresh === null) return seeOther(res, '/login', { 'Set-Cookie': clearedSessionCookie() });
  const device = await issueStaffDevice(session.staffId);
  seeOther(res, '/', { 'Set-Cookie': [sessionCookie(fresh), deviceCookie(device)] });
}

/** The address the member signs in with — how the authenticator app labels the entry. */
async function accountLabel(session: PanelSession): Promise<string> {
  const member = (await listStaff()).find((s) => s.staffId === session.staffId);
  return member?.login ?? session.displayName;
}

async function handleEnrolGet(res: ServerResponse, session: PanelSession, key: Buffer): Promise<void> {
  let secretBase32: string;
  try {
    ({ secretBase32 } = await staffBeginEnrolment(session.staffId, key));
  } catch (err) {
    // Enrolled in the meantime (another browser): the code screen, never a new secret.
    if (err instanceof StaffTotpAlreadyEnrolledError) return seeOther(res, '/2fa');
    throw err;
  }
  const qr = await qrSvg(otpauthUri({ issuer: TOTP_ISSUER, account: await accountLabel(session), secretBase32 }));
  sendHtml(res, 200, renderTotpEnrol({ csrf: issueCsrfToken(session.token), qr, secretBase32 }));
}

/** The typed code, spaces removed (the app shows it as "123 456"). */
function codeFrom(form: URLSearchParams): string {
  return (form.get('code') ?? '').replace(/\s+/g, '');
}

async function handleEnrolPost(req: IncomingMessage, res: ServerResponse, session: PanelSession, key: Buffer): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.token, form.get('csrf'))) return sendHtml(res, 403, renderForbidden());
  const result = await staffConfirmEnrolment(session.staffId, codeFrom(form), key);
  if (result === 'ok') return finishSecondFactor(res, session);
  const csrf = issueCsrfToken(session.token);
  sendHtml(res, 401, renderTotpEnrol({ csrf, error: result === 'locked' ? TOTP_LOCKED : TOTP_BAD_CODE }));
}

async function handleVerifyPost(req: IncomingMessage, res: ServerResponse, session: PanelSession, key: Buffer): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.token, form.get('csrf'))) return sendHtml(res, 403, renderForbidden());
  const result = await staffVerifySecondFactor(session.staffId, codeFrom(form), key);
  if (result === 'ok') return finishSecondFactor(res, session);
  if (result === 'not_enrolled') return seeOther(res, '/2fa/enrol');
  const csrf = issueCsrfToken(session.token);
  sendHtml(res, 401, renderTotpVerify({ csrf, error: result === 'locked' ? TOTP_LOCKED : TOTP_BAD_CODE }));
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, session: PanelSession): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.token, form.get('csrf'))) return sendHtml(res, 403, renderForbidden());
  await revokeStaffSession(session.token);
  seeOther(res, '/login', { 'Set-Cookie': clearedSessionCookie() });
}

// ---------------------------------------------------------------------------
// Staff invite (`/join/<token>`)
// ---------------------------------------------------------------------------

/**
 * What a join form's CSRF token is bound to: the link token, not a session
 * (there is none yet). A session token is bare hex, so `staff-link:` keeps
 * the two from ever colliding.
 */
function joinCsrfBinding(token: string): string {
  return `staff-link:${token}`;
}

/** `/join/<token>`, or `null`. A token of the wrong shape is still a join path — refused readably. */
function joinToken(pathname: string): string | null {
  const match = /^\/join\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * The form. The store has no "is this link usable" read, so a token of the
 * right shape gets the form and a wrong one an invalid-link page; an unknown,
 * used or expired link is refused on submit with the same message, and the
 * link is never consumed by a refused attempt (`redeemStaffLink`).
 */
function handleJoinGet(res: ServerResponse, token: string): void {
  if (!RAW_TOKEN_SHAPE.test(token)) return sendHtml(res, 400, renderJoin({ error: JOIN_LINK_INVALID }));
  sendHtml(res, 200, renderJoin({ form: { action: `/join/${token}`, csrf: issueCsrfToken(joinCsrfBinding(token)) } }));
}

/** Redeem; on success the new session owes enrolment (or the code, if somehow enrolled). */
async function handleJoinPost(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(joinCsrfBinding(token), form.get('csrf'))) return sendHtml(res, 403, renderForbidden());
  if (!RAW_TOKEN_SHAPE.test(token)) return sendHtml(res, 400, renderJoin({ error: JOIN_LINK_INVALID }));
  const retry = (error: string): void =>
    sendHtml(res, 400, renderJoin({ form: { action: `/join/${token}`, csrf: issueCsrfToken(joinCsrfBinding(token)) }, error }));

  const password = form.get('password') ?? '';
  if (password !== (form.get('confirm') ?? '')) return retry(JOIN_PASSWORDS_DIFFER);
  const result = await redeemStaffLink({ rawToken: token, typedLogin: form.get('email') ?? '', password });
  if (!result.ok) {
    if (result.code === 'login_mismatch') return retry(JOIN_LOGIN_MISMATCH);
    if (result.code === 'weak_password') return retry(`הסיסמה קצרה מדי — נדרשים לפחות ${MIN_PASSWORD_LENGTH} תווים.`);
    return sendHtml(res, 400, renderJoin({ error: JOIN_LINK_INVALID }));
  }
  const owed: StaffPendingFactor = (await staffTotpStatus(result.staffId)) === 'enrolled' ? 'verify' : 'enroll';
  const session = await startStaffSession(result.staffId, { pendingFactor: owed });
  seeOther(res, owed === 'enroll' ? '/2fa/enrol' : '/2fa', { 'Set-Cookie': sessionCookie(session) });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface RouteOptions {
  masterKey: Buffer;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: RouteOptions): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = new URL(req.url ?? '/', 'http://admin.local').pathname;

  if (pathname === '/login') {
    if (method === 'GET') return sendHtml(res, 200, renderLogin());
    if (method === 'POST') return handleLoginPost(req, res);
  }

  const join = joinToken(pathname);
  if (join !== null) {
    if (method === 'GET') return handleJoinGet(res, join);
    if (method === 'POST') return handleJoinPost(req, res, join);
  }

  // Everything past this point requires a staff session.
  const token = tokenCookie(req, SESSION_COOKIE);
  if (token === null) return seeOther(res, '/login');
  const found = await verifyStaffSession(token);
  if (found === null) return seeOther(res, '/login', { 'Set-Cookie': clearedSessionCookie() });
  const session: PanelSession = { ...found, token };

  // The second factor: a session that owes it reaches only its own screen and
  // `/logout`; everything else is sent there.
  const screen = await screenForSession(session);
  if (screen !== null) {
    if (method === 'POST' && pathname === '/logout') return handleLogout(req, res, session);
    if (pathname === screen && screen === '/2fa/enrol') {
      if (method === 'GET') return handleEnrolGet(res, session, options.masterKey);
      if (method === 'POST') return handleEnrolPost(req, res, session, options.masterKey);
    }
    if (pathname === screen && screen === '/2fa') {
      if (method === 'GET') return sendHtml(res, 200, renderTotpVerify({ csrf: issueCsrfToken(session.token) }));
      if (method === 'POST') return handleVerifyPost(req, res, session, options.masterKey);
    }
    return seeOther(res, screen);
  }
  if (pathname === '/2fa' || pathname === '/2fa/enrol') return seeOther(res, '/');

  if (method === 'POST' && pathname === '/logout') return handleLogout(req, res, session);
  if (method === 'GET' && pathname === '/') return sendHtml(res, 200, renderHome(viewerOf(session)));

  sendHtml(res, 404, renderNotFound());
}

export function createAdminServer(options: AdminOptions): Server {
  // Loopback only unless the deployment says otherwise: like the dashboard,
  // this server does not terminate TLS and sets Secure cookies.
  const host = options.host ?? '127.0.0.1';
  assertBindableHost(host, options.allowNonLoopbackBind ?? false, ADMIN_BIND);

  const server = createHttpServer((req, res) => {
    handleRequest(req, res, { masterKey: options.masterKey }).catch((err: unknown) => {
      if (err instanceof FormBodyTooLargeError) {
        if (!res.headersSent) sendHtml(res, 413, renderTooLarge());
        else res.end();
        return;
      }
      console.error('admin request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) sendHtml(res, 500, renderServerError());
      else res.end();
    });
  });
  server.listen(options.port ?? 0, host);
  return server;
}
