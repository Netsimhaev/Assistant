/**
 * The approval dashboard, as an HTTP server.
 *
 * `node:http` only — no framework. This is the one screen in stage 0 meant
 * to be reached from the internet (behind a tunnel/reverse proxy that
 * terminates TLS; see docs/dashboard-deployment.md), and it authorises
 * spending money, so every dependency on this surface is something to track
 * and patch for a page that shows a list and a couple of buttons.
 *
 * The server never executes anything. Every route either reads state
 * (`pendingApprovals`, `getApproval`) or writes a human decision through
 * `applyDecision` — the orchestrator does the rest, on its own path, in its
 * own process (`npm run scheduler`).
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getApproval, pendingApprovals } from '../governance/approvals.js';
import { applyDecision } from '../orchestrator/resume.js';
import {
  login,
  revokeAllSessions,
  setPassword,
  startSession,
  verifySessionDetails,
  SESSION_HOURS,
} from './auth.js';
import { redeemRecoveryCode, remainingCodes } from './recovery.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import {
  renderApprovalCard,
  renderForbidden,
  renderLogin,
  renderNotFound,
  renderPasswordChange,
  renderPendingList,
  renderServerError,
} from './views.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_SECONDS = SESSION_HOURS * 3600;
const MIN_PASSWORD_LENGTH = 10;
/** Refuses a form body past this size before it is ever parsed. */
const MAX_BODY_BYTES = 64 * 1024;

export interface DashboardOptions {
  businessId?: string;
  /** Loopback by default — see docs/dashboard-deployment.md for why this must never change in a real deployment. */
  host?: string;
  /** 0 lets the OS assign a free port; tests always pass 0 so runs never collide. */
  port?: number;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length === 0) continue;
    // A malformed `%` escape makes decodeURIComponent throw. A cookie this
    // server issued is never malformed, so the only way to land here is a
    // hand-crafted or corrupted header — which must mean "no session", not
    // a 500. Skipping the pair leaves `out[SESSION_COOKIE]` unset, and
    // `loadSession` already treats that as no session.
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return out;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('form body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Sent on every response, redirects included — the one place all of them
 * pass through, so a route added later cannot forget either header.
 *
 * `Cache-Control: no-store` matters specifically because this server is
 * *required* to sit behind a tunnel or reverse proxy (docs/dashboard-deployment.md):
 * some of those cache dynamic responses by default (a stray "cache everything"
 * rule, a corporate proxy), and a cached approval card is an email body, a
 * counterparty and an amount served to whoever asks next.
 *
 * `X-Frame-Options: DENY` is defence in depth, not a hole being closed —
 * `SameSite=Strict` already keeps the session cookie out of a cross-site
 * iframe, so the approve/deny buttons cannot be clickjacked today. This is
 * cheap insurance against that assumption ever changing.
 */
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
} as const;

function sendHtml(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...SECURITY_HEADERS, ...headers });
  res.end();
}

type Session = { sessionId: string; username: string; mustChangePassword: boolean };

/** `null` when there is no valid session at all — distinct from a valid one that just needs a password change. */
async function loadSession(req: IncomingMessage, businessId: string): Promise<Session | null> {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid) return null;
  const details = await verifySessionDetails(sid, { businessId });
  if (!details) return null;
  return { sessionId: sid, username: details.username, mustChangePassword: details.mustChangePassword };
}

function noteFrom(form: URLSearchParams): string | undefined {
  const raw = form.get('note');
  return raw !== null && raw.trim().length > 0 ? raw : undefined;
}

async function handleLoginGet(res: ServerResponse): Promise<void> {
  sendHtml(res, 200, renderLogin());
}

async function handleLoginPost(req: IncomingMessage, res: ServerResponse, businessId: string): Promise<void> {
  const form = await readFormBody(req);
  const username = form.get('username') ?? '';
  const code = form.get('code');
  const password = form.get('password');

  if (code !== null && code.length > 0) {
    const sourceAddress = req.socket.remoteAddress;
    const result = await redeemRecoveryCode({
      username,
      code,
      businessId,
      ...(sourceAddress !== undefined ? { sourceAddress } : {}),
    });
    if (!result.ok) {
      return sendHtml(res, 401, renderLogin({ error: 'קוד שגוי, כבר נוצל, או שהמערכת נעולה זמנית.' }));
    }
    const token = await startSession(username, { businessId, mustChangePassword: true });
    return redirect(res, '/password', { 'Set-Cookie': sessionCookie(token) });
  }

  if (password === null || password.length === 0) {
    return sendHtml(res, 400, renderLogin({ error: 'יש להזין סיסמה או קוד שחזור.' }));
  }

  const result = await login({ username, password, businessId });
  if (!result.ok) {
    const message =
      result.code === 'locked'
        ? 'החשבון נעול זמנית לאחר ניסיונות כושלים. נסה שוב בעוד כמה דקות.'
        : 'שם משתמש או סיסמה שגויים.';
    return sendHtml(res, 401, renderLogin({ error: message }));
  }

  redirect(res, '/', { 'Set-Cookie': sessionCookie(result.sessionId) });
}

async function handlePasswordGet(res: ServerResponse, session: Session): Promise<void> {
  sendHtml(res, 200, renderPasswordChange({ csrf: issueCsrfToken(session.sessionId) }));
}

async function handlePasswordPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const form = await readFormBody(req);
  const csrf = issueCsrfToken(session.sessionId);

  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderPasswordChange({ csrf, error: 'הטופס פג תוקף. רענן ונסה שוב.' }));
  }

  const password = form.get('password') ?? '';
  const confirm = form.get('confirm') ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return sendHtml(res, 400, renderPasswordChange({ csrf, error: `הסיסמה קצרה מדי — נדרשים לפחות ${MIN_PASSWORD_LENGTH} תווים.` }));
  }
  if (password !== confirm) {
    return sendHtml(res, 400, renderPasswordChange({ csrf, error: 'הסיסמאות אינן תואמות.' }));
  }

  // Revokes every open session, including this one — a fresh, ordinary
  // session (mustChangePassword: false) replaces it right after, so the
  // owner lands back in the app instead of at a login form.
  await setPassword({ username: session.username, password, businessId });
  const token = await startSession(session.username, { businessId, mustChangePassword: false });
  redirect(res, '/', { 'Set-Cookie': sessionCookie(token) });
}

async function handlePendingList(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const [approvals, remaining] = await Promise.all([
    pendingApprovals({ businessId }),
    remainingCodes(session.username, { businessId }),
  ]);
  sendHtml(
    res,
    200,
    renderPendingList({ approvals, remainingCodes: remaining, csrf: issueCsrfToken(session.sessionId) }),
  );
}

async function handleCard(res: ServerResponse, businessId: string, session: Session, approvalId: string): Promise<void> {
  // Scoped by businessId in the same query that loads the row — an approval
  // belonging to another business must not be distinguishable from one that
  // does not exist at all, so both come back 404, never 403.
  const approval = await getApproval(approvalId, { businessId });
  if (!approval) return sendHtml(res, 404, renderNotFound());
  sendHtml(res, 200, renderApprovalCard({ approval, csrf: issueCsrfToken(session.sessionId) }));
}

async function handleDecision(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  approvalId: string,
  outcome: 'approved' | 'denied',
): Promise<void> {
  const form = await readFormBody(req);

  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const approval = await getApproval(approvalId, { businessId });
  if (!approval) return sendHtml(res, 404, renderNotFound());

  const note = noteFrom(form);
  await applyDecision(
    approvalId,
    outcome,
    { by: session.username, channel: 'dashboard', ...(note !== undefined ? { note } : {}) },
    { businessId },
  );

  redirect(res, '/');
}

async function handleLogout(req: IncomingMessage, res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }
  await revokeAllSessions(session.username, { businessId });
  redirect(res, '/login', { 'Set-Cookie': clearedCookie() });
}

const CARD_PATH = /^\/a\/([^/]+)$/;
const DECISION_PATH = /^\/a\/([^/]+)\/(approve|deny)$/;

async function route(req: IncomingMessage, res: ServerResponse, businessId: string): Promise<void> {
  const method = req.method ?? 'GET';
  const pathname = new URL(req.url ?? '/', 'http://dashboard.local').pathname;

  if (method === 'GET' && pathname === '/login') return handleLoginGet(res);
  // Deliberately no CSRF check here — not an oversight. A CSRF token is
  // bound to a session id, and there is no session yet at this point in the
  // request. Classic "login CSRF" (a cross-site form submitting attacker-
  // known credentials so the victim's browser ends up authenticated as the
  // attacker) has no target here either: this is a single account, created
  // out-of-band by a local CLI command, with no self-registration — making
  // either branch of this form succeed already requires possessing that one
  // account's password or an unredeemed recovery code, at which point the
  // attacker already has direct access and gains nothing by routing it
  // through the victim's browser.
  if (method === 'POST' && pathname === '/login') return handleLoginPost(req, res, businessId);

  // Everything past this point requires a session.
  const session = await loadSession(req, businessId);
  if (!session) return redirect(res, '/login');

  if (method === 'GET' && pathname === '/password') return handlePasswordGet(res, session);
  if (method === 'POST' && pathname === '/password') return handlePasswordPost(req, res, businessId, session);
  if (method === 'POST' && pathname === '/logout') return handleLogout(req, res, businessId, session);

  // A session minted from a recovery code cannot reach anything else —
  // checked here, after /password and /logout have already had their turn,
  // so the forced change can neither be skipped by navigating straight to
  // `/` nor leave the owner stuck with no way to sign out.
  if (session.mustChangePassword) return redirect(res, '/password');

  if (method === 'GET' && pathname === '/') return handlePendingList(res, businessId, session);

  const cardMatch = CARD_PATH.exec(pathname);
  if (method === 'GET' && cardMatch) {
    const id = cardMatch[1];
    if (id !== undefined) return handleCard(res, businessId, session, id);
  }

  const decisionMatch = DECISION_PATH.exec(pathname);
  if (method === 'POST' && decisionMatch) {
    const id = decisionMatch[1];
    const action = decisionMatch[2];
    if (id !== undefined && action !== undefined) {
      return handleDecision(req, res, businessId, session, id, action === 'approve' ? 'approved' : 'denied');
    }
  }

  sendHtml(res, 404, renderNotFound());
}

export function createServer(options: DashboardOptions = {}): Server {
  const businessId = options.businessId ?? config.businessId;
  // Loopback only, always — see docs/dashboard-deployment.md. This server
  // does not terminate TLS; anything reachable from the internet must arrive
  // through a tunnel or reverse proxy that does, never by binding a public
  // interface here.
  const host = options.host ?? '127.0.0.1';

  const server = createHttpServer((req, res) => {
    route(req, res, businessId).catch((err: unknown) => {
      console.error('dashboard request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        sendHtml(res, 500, renderServerError());
      } else {
        res.end();
      }
    });
  });

  server.listen(options.port ?? 0, host);
  return server;
}
