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
import { z } from 'zod';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { ApprovalNotDecidableError, getApproval, pendingApprovals } from '../governance/approvals.js';
import type { ApprovalRequest } from '../governance/approvals.js';
import { DocumentAlreadySignedError, loadSignature } from '../governance/signatures.js';
import type { SignatureRecord } from '../governance/signatures.js';
import { decideAndSign } from '../governance/sign-decision.js';
import { applyDecision, resumeAfterDecision } from '../orchestrator/resume.js';
import { runInstruction } from '../orchestrator/instruct.js';
import { applyConfirmation, dashboardConfirmations } from '../orchestrator/command-confirm.js';
import { loadConfirmation } from '../governance/instruction-confirmations.js';
import { loadJob, transition } from '../orchestrator/jobs.js';
import {
  MAX_INSTRUCTION_CHARS,
  loadInstructionForJob,
  pendingQuestions,
  claimAnswer,
} from '../governance/instructions.js';
import type { InstructionTextOrigin } from '../governance/typed-recipients.js';
import { readForgetCommand } from '../governance/forget-command.js';
import { AutonomyMode, loadAutonomyMode, setAutonomyMode } from '../governance/autonomy-mode.js';
import { recordCorrection } from '../governance/corrections.js';
import { listAutonomousActions, markUpdatesSeen, unseenUpdateKeys } from './autonomous-actions.js';
import { learningSnapshot, type LearningSnapshot } from './learning-view.js';
import {
  loadActionUpdateSettings,
  saveActionUpdateSettings,
  type ActionUpdateSettings,
} from '../governance/action-update-settings.js';
import { probeActiveCharter, loadActiveCharter } from '../charter/store.js';
import type { ActiveCharter } from '../charter/store.js';
import { DigestSchedule, loadDigestSettings, setDigestSettings } from '../governance/digest-settings.js';
import type { DigestSettings } from '../governance/digest-settings.js';
import { recentDigests } from '../orchestrator/digest-store.js';
import { collectDigestFacts } from '../orchestrator/digest-facts.js';
import { renderDigest } from '../orchestrator/digest-render.js';
import { lastHourInstant, scheduledHourFor, WEEK_MS } from '../orchestrator/digest-window.js';
import type { DigestKind } from '../orchestrator/digest-window.js';
import { renderDigestScreen } from './digest-view.js';
import type { CharterConnection } from '../domain/connection.js';
import { loadBindings } from '../orchestrator/bindings.js';
import { listGrants } from '../governance/oauth-grants.js';
import { buildErasurePlan } from '../governance/erasure-plan.js';
import type { ErasureAnchor, ErasurePlan } from '../governance/erasure-plan.js';
import {
  ErasureAuditUnrecordedError,
  ErasureRefusedError,
  executeErasure,
} from '../governance/erasure.js';
import type { ErasureOutcome } from '../governance/erasure.js';
import { keepItem, listKept, revokeKeep } from '../governance/kept-items.js';
import type { KeptItemKind } from '../governance/kept-items.js';
import {
  loadVerificationOutcome,
  type NotJudgedReason,
  type Verdict,
} from '../governance/verdict-store.js';
import { documentForApproval } from './document-for-approval.js';
import {
  DEFAULT_DASHBOARD_BASE_URL,
  handleOAuthCallback,
  handleOAuthRevoke,
  handleOAuthStart,
} from './oauth-routes.js';
import type { OAuthRouteOptions } from './oauth-routes.js';
import { MAILBOX_SYSTEM, type MailProvider } from '../mail/mailbox.js';
import type { MailboxClient } from '../mail/providers/types.js';
import { isMailReplyJob } from '../mail/inbox-store.js';
import { mailReplyEditRefusal, mailboxReplyRecipient } from '../mail/reply-card.js';
import {
  handleMailboxRevertPost,
  handleMailboxSignGet,
  handleMailboxSignPost,
  handleMailboxStatus,
} from './mailbox-connect.js';
import { handleDocumentFile, handleInvoices, handleMailDetail, handleMailDocuments, handleMailList, notFound } from './mail-handlers.js';
import { isDocumentDecisionIntent } from './signable-intents.js';
import { recentReadings } from './readings-list.js';
import { MAX_RECALL, recallMemories } from '../memory/store.js';
import { conversation } from '../whatsapp/store.js';
import { renderConversation } from './conversation-view.js';
import { verifyDocumentUnchanged } from '../documents/verify.js';
import type { VerifyOutcome } from '../documents/verify.js';
import { canonicalHash } from '../util/canonical.js';
import {
  login,
  revokeAllSessions,
  setPassword,
  startSession,
  verifyCurrentPassword,
  verifySessionDetails,
  SESSION_HOURS,
} from './auth.js';
import { redeemRecoveryCode, remainingCodes } from './recovery.js';
import { issueCsrfToken, verifyCsrfToken } from './csrf.js';
import {
  renderApprovalCard,
  renderAutonomousActions,
  renderAutonomy,
  renderConnections,
  renderErasure,
  renderErasureDone,
  renderForbidden,
  renderInstruct,
  renderLogin,
  renderMemory,
  renderNotFound,
  renderPasswordChange,
  renderPendingList,
  renderReadings,
  renderServerError,
} from './views.js';
import type { CharterReadStatus } from './views.js';
import type { ErasurePrefill } from './views.js';

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_SECONDS = SESSION_HOURS * 3600;
const MIN_PASSWORD_LENGTH = 10;
/** Refuses a form body past this size before it is ever parsed. */
const MAX_BODY_BYTES = 64 * 1024;

export interface DashboardOptions {
  businessId?: string;
  /**
   * Permission to bind an interface other than loopback. Off by default, and
   * `assertBindableHost` refuses loudly without it.
   */
  allowNonLoopbackBind?: boolean;
  /** Loopback by default — see docs/dashboard-deployment.md for why this must never change in a real deployment. */
  host?: string;
  /** 0 lets the OS assign a free port; tests always pass 0 so runs never collide. */
  port?: number;
  /**
   * Whether a `X-Forwarded-For` header on an incoming request may be
   * believed. Off by default, and it must stay off unless the only way to
   * reach this port is through a proxy that sets the header itself.
   *
   * The header is client-supplied text on an open socket. Trusting it
   * unconditionally is worse than ignoring it: an attacker would then choose
   * what the audit log says about where a credential-recovery event came
   * from, which is more damaging than a record that plainly says "this is
   * the proxy's address". So this is opt-in, per deployment, by whoever
   * knows the topology.
   */
  trustProxy?: boolean;
  /**
   * Where a signed document's bytes live on disk, for `verifyDocumentUnchanged`
   * to re-hash at signing time. Defaults to `config.documentRoot` when unset —
   * this option exists so tests can point the sign route at an isolated temp
   * directory instead of the real deployment's document store.
   */
  documentRoot?: string;
  /**
   * Path to the master key file the OAuth consent ceremony (`oauth-routes.ts`)
   * needs to resolve the Google app's own client id/secret and to seal a
   * freshly-granted refresh token. Defaults to `process.env['CREDENTIAL_KEY_PATH']`
   * when unset — the same env var `buildRuntime` and `secret.ts` read, so an
   * installation only ever has one key file to point at. Tests pass an
   * isolated one, the same way `documentRoot` lets them isolate the document
   * store above.
   */
  credentialKeyPath?: string;
  /**
   * The externally-reachable base URL the OAuth redirect_uri is built from —
   * the SAME base URL `buildRuntime` already uses for approval links
   * (`DASHBOARD_BASE_URL`), never this process's own bind host/port, which
   * may sit behind a tunnel with a different public name. Defaults to
   * `process.env['DASHBOARD_BASE_URL']`, then the same fallback `runtime.ts`
   * uses.
   */
  dashboardBaseUrl?: string;
  /**
   * Test seam for the OAuth code exchange and account lookup — the same
   * discipline `buildRuntime`'s `overrides.tokenHttp`/`overrides.calendarHttp`
   * keep. No production caller ever passes it.
   */
  oauthFetch?: typeof fetch;
  /**
   * Test seam for the mailbox client the OAuth callback takes the initial
   * cursor with. No production caller passes it: absent, the callback uses
   * the real Gmail / Graph client for the provider.
   */
  mailboxClientFor?: (provider: MailProvider) => MailboxClient;
}

/**
 * `SameSite=Lax`, not `Strict`. Google returns the owner to `/oauth/callback`
 * by a cross-site TOP-LEVEL NAVIGATION (a real browser redirect after the
 * owner clicks "allow"), and a `Strict` cookie is withheld on exactly that —
 * the callback would see no session, redirect to `/login` without preserving
 * the query string, and silently discard the authorisation code.
 *
 * **The trade this makes, named rather than hidden:** under `Lax`, a
 * cross-site top-level navigation DOES still carry the session cookie to a
 * GET. `GET /oauth/:system/start` is **the one GET a cross-site navigation
 * can USEFULLY reach this way** — not, as an earlier version of this
 * paragraph claimed, "the one GET route in this file that writes anything".
 * `GET /oauth/callback` writes MORE than `/start` does — the grant, the
 * binding and the audit row, all in one transaction (see
 * `handleOAuthCallback`'s own docblock) — so calling it read-only here was
 * false (final fix wave, item 3). What actually stops a forged navigation
 * from doing anything USEFUL there is that the callback additionally needs
 * a single-use `state` row bound to the CALLER'S OWN SESSION (`consumeState`)
 * plus a real authorisation `code` Google only ever hands the browser that
 * completed its consent screen — neither of which an attacker's own
 * navigation can supply for a victim it does not control. `/start` has no
 * such requirement: a bare cross-site navigation to it is enough on its own
 * to mint a state row, which is exactly what makes it the route worth
 * naming here. What that navigation writes is a pending, session-bound,
 * SINGLE-USE `state` row (`createState`), never a grant and never a
 * binding. That gains an attacker nothing: finishing the ceremony still
 * requires the VICTIM to approve at Google's own consent screen, and the
 * callback then binds the VICTIM's own account to the business, never the
 * attacker's — the forged navigation just creates an inert row that expires
 * unused. Every other route that mutates something the owner would actually
 * care about is a POST, which `Lax` withholds the cookie from cross-site
 * regardless — see `SECURITY_HEADERS`'s own docblock.
 */
function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** An audited address is never longer than this. A header is attacker-supplied text even when the proxy is trusted. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Where a request came from, as the audit log should name it.
 *
 * `req.socket.remoteAddress` is the *previous hop*, and this server is
 * required to sit behind a tunnel or reverse proxy
 * (docs/dashboard-deployment.md) — so in every real deployment that address
 * is the proxy, and recording it bare made every recovery-code redemption
 * audit as coming from localhost. The only record of a credential-recovery
 * event named the wrong origin, and named it confidently.
 *
 * Two honest answers, and this returns whichever one the deployment has
 * earned:
 *
 *   * `trustProxy` off (the default): the socket address, labelled as the
 *     proxy's and not the client's. Useless for tracing, but it does not
 *     claim to be something it is not.
 *   * `trustProxy` on: the LAST entry of `X-Forwarded-For`. Last, not first:
 *     each proxy appends the address it saw, so the rightmost entry is the
 *     one the nearest (and only trusted) proxy wrote, while everything to
 *     its left may have been sent by the client. Reading the leftmost entry
 *     — the usual mistake — is reading whatever an attacker typed.
 */
/**
 * `decodeURIComponent` on a path segment, refused rather than thrown.
 *
 * Mirrors `parseCookies`'s own handling of the identical hazard eighteen
 * lines below this file's cookie parsing (a malformed `%` escape must mean
 * "not this", never a 500): a system name in an OAuth route's path is
 * attacker-reachable text (anyone who can get the owner to click a link, or
 * who is probing directly), and a hand-crafted `%` escape must read as a
 * readable refusal, not a crash.
 */
function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const socketAddress = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return `${socketAddress} (proxy hop; not the client address)`;

  const raw = req.headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  const hops = joined
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  const nearest = hops[hops.length - 1];
  if (nearest === undefined) {
    // Trusted proxy configured, no header present: say so rather than
    // silently reporting the socket as the client.
    return `${socketAddress} (proxy hop; no forwarded-for header)`;
  }
  return nearest.slice(0, MAX_ADDRESS_LENGTH);
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

/** Distinct from a generic read failure so a caller can give a readable answer instead of a 500. */
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
 * `X-Frame-Options: DENY` is defence in depth, not a hole being closed. The
 * session cookie is `SameSite=Lax`, not `Strict` (see `sessionCookie`'s own
 * docblock for why the OAuth callback needs that, and for the one named GET
 * that trade accepts). Every route here that mutates something the owner
 * would actually care about — approve, deny, sign, erase, change a
 * password, revoke a grant — is a POST carrying its own CSRF token, and
 * `Lax` withholds the session cookie from a cross-site POST regardless of
 * framing; THAT is what keeps those buttons from being clickjacked, not the
 * cookie's SameSite mode standing alone. `X-Frame-Options` is cheap
 * insurance on top of that, not the control itself.
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

async function handleLoginPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  trustProxy: boolean,
): Promise<void> {
  const form = await readFormBody(req);
  const username = form.get('username') ?? '';
  const code = form.get('code');
  const password = form.get('password');

  if (code !== null && code.length > 0) {
    const result = await redeemRecoveryCode({
      username,
      code,
      businessId,
      sourceAddress: clientAddress(req, trustProxy),
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

/**
 * A password change needs the current password — except on the one path
 * where there cannot be one.
 *
 * `mustChangePassword` is set only by the session minted immediately after a
 * recovery code was redeemed, and redemption is itself proof of ownership
 * (it revoked every other session on the way through). Everywhere else, a
 * session alone must not be enough: this route sits before the
 * must-change gate and after nothing at all, so without the current password
 * a stolen cookie is a permanent takeover rather than a twelve-hour one.
 */
function requiresCurrentPassword(session: Session): boolean {
  return !session.mustChangePassword;
}

async function handlePasswordGet(res: ServerResponse, session: Session): Promise<void> {
  sendHtml(
    res,
    200,
    renderPasswordChange({
      csrf: issueCsrfToken(session.sessionId),
      requireCurrent: requiresCurrentPassword(session),
    }),
  );
}

async function handlePasswordPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const form = await readFormBody(req);
  const csrf = issueCsrfToken(session.sessionId);
  const requireCurrent = requiresCurrentPassword(session);
  const view = (status: number, error: string): void =>
    sendHtml(res, status, renderPasswordChange({ csrf, requireCurrent, error }));

  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return view(403, 'הטופס פג תוקף. רענן ונסה שוב.');
  }

  // Checked before the new password is even looked at: a caller who cannot
  // prove what the password is now has no business proposing what it becomes.
  if (requireCurrent) {
    const current = form.get('current') ?? '';
    const ok =
      current.length > 0 &&
      (await verifyCurrentPassword({ username: session.username, password: current, businessId }));
    if (!ok) return view(403, 'הסיסמה הנוכחית שגויה.');
  }

  const password = form.get('password') ?? '';
  const confirm = form.get('confirm') ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return view(400, `הסיסמה קצרה מדי — נדרשים לפחות ${MIN_PASSWORD_LENGTH} תווים.`);
  }
  if (password !== confirm) {
    return view(400, 'הסיסמאות אינן תואמות.');
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

/** How many recent readings the "מה קראתי" screen shows. */
const READINGS_LIST_LIMIT = 50;

async function handleReadings(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const rows = await recentReadings(READINGS_LIST_LIMIT, { businessId });
  sendHtml(res, 200, renderReadings(rows, issueCsrfToken(session.sessionId)));
}

/** How many of the most recent messages "שיחת הוואטסאפ" shows. */
const CONVERSATION_LIMIT = 200;

/**
 * "שיחת הוואטסאפ" — the full record, oldest first (`conversation`'s own
 * ordering), behind the owner session exactly as `/connections` is. See
 * `conversation-view.ts`'s own docblock for why the compose box this renders
 * is a view onto `POST /instruct` and never a second door to the outside.
 *
 * **Truncation is detected, not guessed (fix round 1, Important 2).** This
 * screen calls itself the full record, and a silent cutoff past
 * `CONVERSATION_LIMIT` would make that false. Asking for `CONVERSATION_LIMIT
 * + 1` and checking whether that many came back is the honest test;
 * `fetched.length === CONVERSATION_LIMIT` is NOT — that is also exactly what
 * a history of precisely 200 messages looks like, and guessing from it would
 * tell an owner with no more history that some was hidden. `conversation()`
 * returns its window newest-last (the N most recent, re-sorted oldest
 * first), so when there is one row too many the one being dropped is the
 * single OLDEST of the fetched batch — `fetched.slice(1)` — not the newest.
 */
async function handleConversation(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const fetched = await conversation({ businessId, limit: CONVERSATION_LIMIT + 1 });
  const truncated = fetched.length > CONVERSATION_LIMIT;
  const messages = truncated ? fetched.slice(fetched.length - CONVERSATION_LIMIT) : fetched;
  sendHtml(res, 200, renderConversation({ messages, csrf: issueCsrfToken(session.sessionId), truncated }));
}

/**
 * "מה נזכר" — read-only, on purpose. `recallMemories({})` with no
 * `subjectKey`/`keyword` returns the most recent rows rather than everything
 * (see that function's own docblock: "recall everything" is not a question
 * the store answers), so this asks for `MAX_RECALL` — the same cap the store
 * itself enforces on any caller — rather than a smaller default meant for a
 * single recall during planning.
 */
async function handleMemory(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const memories = await recallMemories({ limit: MAX_RECALL }, { businessId });
  sendHtml(res, 200, renderMemory(memories, issueCsrfToken(session.sessionId)));
}

/**
 * "חיבורים" — one heading per kind of connection (`connection-groups.ts`),
 * every connection the signed charter declares under it, and whether it is
 * authorised.
 *
 * **This screen is a reader, and must survive a charter it cannot read.**
 * `loadActiveCharter` (`charter/store.ts`) THROWS on a schema-version
 * mismatch and returns `null` when nothing is installed — both deliberately
 * fatal for the gate, which must never run an agent against policy it cannot
 * parse. A dashboard screen is a different kind of caller: showing the owner
 * a 500, or worse a silently-empty connections list indistinguishable from
 * "nothing is declared", when the real problem is an unreadable charter is
 * strictly worse than the truth.
 *
 * **This route used to catch the throw locally, and that was right at the
 * time.** It was written on a branch where `probeActiveCharter` did not exist
 * — an earlier note here recorded grepping for it and finding nothing, which
 * was accurate: it was built on a parallel branch that had not merged. Both
 * branches had reached the same conclusion independently and each solved it
 * with what it had. This is the merge, so the local catch stops being the
 * honest answer: two different answers to one question, in one codebase, is
 * the drift the invariants elsewhere in this project exist to prevent.
 *
 * `probeActiveCharter` returns the failure instead of throwing it, and its
 * own docblock names the callers allowed to ask — the install path, the
 * readiness report, and now this screen. That list is deliberately short:
 * every production reader must keep failing loudly, because work running
 * against a policy nobody can parse is work running against no policy.
 *
 * **What has not changed is the log line.** A screen degrading readably for
 * the owner and a failure being invisible to the operator are two different
 * things. A schema-version mismatch, a transient Postgres failure and a
 * corrupt row all produce the same fixed Hebrew message here, and every
 * OTHER unexpected failure in this file reaches the route-level handler that
 * logs `dashboard request failed:` before rendering a 500. Avoiding that 500
 * must not also mean avoiding the log line an operator would find for
 * `/readings` or `/memory` and not for this one.
 */
async function handleConnections(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  let charterStatus: CharterReadStatus;
  let connections: CharterConnection[];
  const probe = await probeActiveCharter(businessId);
  if (!probe.ok) {
    console.error('connections screen: could not read the active charter:', probe.reason);
    charterStatus = 'unreadable';
    connections = [];
  } else if (probe.active === null) {
    charterStatus = 'none';
    connections = [];
  } else {
    charterStatus = 'ok';
    connections = probe.active.charter.connections;
  }

  const [bindings, grants] = await Promise.all([
    loadBindings({ businessId }),
    listGrants(businessId),
  ]);

  sendHtml(
    res,
    200,
    renderConnections({
      charterStatus,
      connections,
      bindings,
      grants,
      csrf: issueCsrfToken(session.sessionId),
    }),
  );
}

/** `DD/MM HH:MM`, local to `timeZone` — the live window's own start label. */
function formatWindowStart(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}

/** Which kind the live preview shows: the owner's own schedule, where it says one unambiguously. */
function previewKind(schedule: DigestSchedule): DigestKind {
  // 'weekly' is the only schedule that does NOT include a daily digest at
  // all (fix round 1, item 2) — previewing 'daily' for it would title the
  // preview "תדריך יומי" for an owner who will never receive one. Every
  // other value ('daily', 'both', 'off') includes the daily shape, or (for
  // 'off') is shown as an illustrative example of it — `renderLiveSection`
  // (`digest-view.ts`) adds that caveat for 'off' specifically.
  return schedule === 'weekly' ? 'weekly' : 'daily';
}

/**
 * The live preview's own window start.
 *
 * **Fix round 2, item 6.** `lastHourInstant` answers "the nearest past
 * occurrence of this hour on the clock" — it has no notion of weekday, so
 * for a WEEKLY schedule it still only looks back up to 24 hours (the hour
 * recurs daily) and never the 7 days a weekly digest actually spans. The
 * title (`renderDigest`'s own `KIND_LABEL`) already says "תדריך שבועי" via
 * `previewKind`, so a daily-sized span under that title claimed to cover a
 * week while showing less than a day of it. Widening by a further
 * `WEEK_MS` for the weekly case gives a preview whose span actually matches
 * its own title, the same way the daily case's span already matches "תדריך
 * יומי".
 *
 * Exported so a unit test can pin the exact span without re-deriving `now`
 * at a different instant than the one the request handler captured.
 */
export function liveWindowStart(
  settings: DigestSettings,
  kind: DigestKind,
  now: Date,
  timeZone: string,
): Date {
  const boundary = lastHourInstant(scheduledHourFor(settings, kind), timeZone, now) ?? now;
  return kind === 'weekly' ? new Date(boundary.getTime() - WEEK_MS) : boundary;
}

const CHARTER_NONE_TEXT = 'טרם נחתם תקנון עסקי — תצוגה חיה תופיע לאחר החתימה.';
const CHARTER_UNREADABLE_TEXT = 'התקנון החתום אינו קריא כרגע, ולכן אי אפשר להציג תצוגה חיה.';

/**
 * "מה קרה" — the stored digest history, a live preview, and the
 * schedule/channel settings form.
 *
 * **The live preview needs the charter's time zone and money ceiling, so it
 * reads the charter via `loadActiveCharter` — never `probeActiveCharter`.**
 * `probeActiveCharter`'s own docblock (`charter/store.ts`) reserves it for
 * exactly three callers: the install path, the readiness report, and the
 * connections screen. Widening that list quietly undoes the control it sits
 * beside — so the fix for a fresh install (no charter yet) is to catch
 * `loadActiveCharter` LOCALLY, which widens nothing, rather than to route
 * around the one control that already exists for this exact question.
 *
 * **Fix round 1, item 1: `active === null` is "no charter signed yet" — an
 * ordinary state on a brand-new installation — never an error, and a throw
 * from `loadActiveCharter` is "the signed charter cannot be read" — a schema
 * mismatch. These are different facts and get different Hebrew sentences**
 * (`CHARTER_NONE_TEXT` / `CHARTER_UNREADABLE_TEXT`), exactly the way
 * `handleConnections` already treats "none" and "unreadable" as different
 * `charterStatus` values rather than one. Neither case 500s: `recentDigests`
 * and `loadDigestSettings` never needed the charter at all, so the history
 * and the settings form render in both cases, and only the live-preview
 * section is replaced with the one explanatory line.
 *
 * The live window previews whichever kind the owner's OWN schedule actually
 * includes — `previewKind` — not unconditionally 'daily' (fix round 1, item
 * 2): a weekly-only owner previewing a daily digest is a mislabelled
 * preview, and this screen exists so he can tell what he was told from what
 * he might be, which a wrong heading spends.
 */
async function handleDigestGet(
  res: ServerResponse,
  businessId: string,
  session: Session,
  error?: string,
): Promise<void> {
  const settings = await loadDigestSettings({ businessId });
  const stored = await recentDigests({ businessId });

  let active: ActiveCharter | null;
  let liveUnavailable: string | undefined;
  try {
    active = await loadActiveCharter(businessId);
    if (active === null) liveUnavailable = CHARTER_NONE_TEXT;
  } catch (err) {
    active = null;
    liveUnavailable = CHARTER_UNREADABLE_TEXT;
    console.error('digest screen: could not read the active charter:', err instanceof Error ? err.message : err);
  }

  let live: { body: string; windowLabel: string } | null = null;
  // The zone the HISTORY table (`renderDigestScreen`'s stored-row dates) is
  // shown in. When a charter is actually readable this is its own zone —
  // the same one the live preview and `runDigests` itself use. When it is
  // not (fresh install, or a schema the code cannot parse — `liveUnavailable`
  // already says which), there is no charter zone to read at all; 'UTC' is
  // an explicit, documented stand-in for that edge case, not the silent
  // per-session inheritance `shortDate` (`digest-view.ts`) used to fall
  // into — the two are never the same bug twice.
  let timeZone = 'UTC';
  if (active !== null) {
    timeZone = active.charter.identity.timezone;
    const ceilings = {
      monthlyMinor: active.bundle.ceilings.monthlyMinor,
      currency: active.bundle.ceilings.currency,
      timeZone,
    };
    const kind = previewKind(settings.schedule);
    const now = new Date();
    const start = liveWindowStart(settings, kind, now, timeZone);
    const window = { kind, start, end: now, windowsCovered: 1 };
    const rendered = renderDigest(await collectDigestFacts(window, ceilings, { businessId }));
    live = { body: rendered.body, windowLabel: `${formatWindowStart(start, timeZone)} – עכשיו` };
  }

  sendHtml(
    res,
    200,
    renderDigestScreen({
      settings,
      stored,
      live,
      timeZone,
      ...(liveUnavailable !== undefined ? { liveUnavailable } : {}),
      csrf: issueCsrfToken(session.sessionId),
      ...(error !== undefined ? { error } : {}),
    }),
  );
}

/**
 * The owner's own choices: schedule and which channels to use.
 *
 * An out-of-range hour/day is refused by the database CHECK constraints
 * (migration 040) — `setDigestSettings` throws, and that throw is the real
 * enforcement, not a TypeScript range check here that could drift from it.
 * The `<select>` elements this screen renders only ever offer in-range
 * values, so the catch below is for a tampered or hand-built request, not
 * the normal path.
 *
 * **Fix round 1, item 4: a MISSING field must fail, not coerce to `0`.**
 * `form.get(...)` returns `string | null`, and `z.coerce.number()` happily
 * parses `null` into `0` (`Number(null) === 0`) — so a hand-built POST that
 * simply omits `dailyHour` was silently accepted as midnight rather than
 * refused. `z.string().min(1)` rejects `null` and `''` by construction
 * (wrong type / too short) before the value ever reaches `Number(...)`,
 * which is this codebase's own rule stated in those words elsewhere —
 * "a value we could not read is not a permitting value" (`readAmountMinor`,
 * an unresolved time zone, an unknown calendar action) — applied to a form
 * field reaching the same door. `.pipe(z.number().int())`, not
 * `z.coerce.number().int()` directly, because zod's `number()` already
 * treats `NaN` (what `Number('abc')` produces) as its own invalid type
 * rather than a number that merely fails `.int()` — this chain refuses a
 * non-numeric string for the same reason it refuses a missing one.
 */
const RequiredHourField = z
  .string()
  .min(1)
  .transform((v) => Number(v))
  .pipe(z.number().int());

const DigestSettingsForm = z.object({
  schedule: DigestSchedule,
  dailyHour: RequiredHourField,
  weeklyDay: RequiredHourField,
  weeklyHour: RequiredHourField,
});

async function handleDigestSettingsPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const parsed = DigestSettingsForm.safeParse({
    schedule: form.get('schedule'),
    dailyHour: form.get('dailyHour'),
    weeklyDay: form.get('weeklyDay'),
    weeklyHour: form.get('weeklyHour'),
  });

  if (!parsed.success) {
    return handleDigestGet(res, businessId, session, 'יש לבחור ערכים תקינים בכל שדות התדריך.');
  }

  const toEmail = form.get('toEmail') === 'on';
  const toWhatsApp = form.get('toWhatsApp') === 'on';

  try {
    await setDigestSettings({ ...parsed.data, toEmail, toWhatsApp }, session.username, { businessId });
  } catch {
    return handleDigestGet(
      res,
      businessId,
      session,
      'השעה או היום שנבחרו אינם בטווח התקין — יש לבחור שעה בין 00 ל-23 ויום בין ראשון לשבת.',
    );
  }

  redirect(res, '/digest');
}

/**
 * Renders `runInstruction`'s outcome exactly the same way whether it came
 * from a fresh submission or from an answer to a clarifying question — the
 * pipeline does not care which one produced the text it just planned (or
 * refused, or asked about again).
 *
 * A `planned` outcome carrying any of the three notes renders the box instead
 * of redirecting home. `grantNote` is non-null in exactly one case — a plan
 * spanning more than one action class, which authorises nothing at all (see
 * `grantForPlan` in `instruct.ts`) — and without showing it here the owner is
 * bounced straight to the pending list and later meets an approval card for
 * something they believed the instruction had already covered, with no
 * sentence anywhere explaining why the shortcut did not apply.
 *
 * `identityNote` is non-null when a name stayed ambiguous after the owner had
 * already answered once, so the instruction ran with none of that person's
 * memory (spec §7.2's "ומציינת זאת"). Redirecting home on that outcome is
 * what made the silence: an ordinary success page, and an owner who believes
 * their answer worked. All three notes are passed together — they answer
 * different questions and one instruction can raise more than one.
 *
 * `recordingNote` is non-null only when the planned text came from a
 * recording and that is what kept a recipient off the standing authorisation
 * (`recipientsOnlyInRecording`, `governance/typed-recipients.ts`). **This
 * screen really can produce it, which is why it renders here and not only in
 * the WhatsApp ack:** `POST /instruct` states `'typed'` and so can never
 * raise it, but the answer route below plans the join of a typed answer and
 * a parked instruction that may itself have arrived as a voice note, and
 * that join is `'transcribed'`. Leaving it unrendered here would be a note
 * written for the owner that one of its two producers never shows him.
 *
 * A `needs_answer` outcome carries the same note and renders it beside the
 * question card, which is the case a live run measured: an unresolved name
 * empties the memory block, a planner with no context returns its own
 * clarifying question, and the outcome the owner sees is this one — so a note
 * that rode `planned` alone reached them exactly never, in the situation it
 * was written for. The identity question's own return sets the note to `null`
 * because that question already is the notice (see `instruct.ts`), so this
 * branch needs no condition of its own: it renders whatever was carried.
 *
 * Exported for `server.test.ts`, the same reason `reasonForSupersededJob`
 * below is: this route cannot inject a planner, so the only way to prove the
 * `needs_answer` branch really passes the note on is to call it directly.
 */
export async function renderInstructionOutcome(
  res: ServerResponse,
  session: Session,
  outcome: Awaited<ReturnType<typeof runInstruction>>,
  businessId: string,
): Promise<void> {
  const csrf = issueCsrfToken(session.sessionId);

  if (outcome.status === 'refused') {
    sendHtml(res, 400, renderInstruct({ csrf, error: outcome.reason }));
    return;
  }
  if (outcome.status === 'needs_answer') {
    sendHtml(
      res,
      200,
      renderInstruct({
        csrf,
        identityNote: outcome.identityNote,
        pending: [{ jobId: outcome.jobId, question: outcome.question, text: outcome.instructionText }],
      }),
    );
    return;
  }
  // Boss command (spec §4.3): the job is parked on a confirmation question.
  // The question, whole, with one button per option — each posting the
  // `planHash` it was shown with — and a cancel. The options come from the
  // stored row, the same row `POST /instruct/:jobId/confirm` checks against.
  if (outcome.status === 'needs_confirmation') {
    const confirmation = await loadConfirmation(outcome.jobId, { businessId });
    sendHtml(
      res,
      200,
      renderInstruct({
        csrf,
        ...(confirmation === null
          ? { confirmationQuestion: outcome.question }
          : {
              confirmations: [
                {
                  jobId: outcome.jobId,
                  question: outcome.question,
                  options: confirmation.options.map((o) => ({ label: o.label, planHash: o.planHash })),
                },
              ],
            }),
        identityNote: outcome.identityNote,
      }),
    );
    return;
  }
  if (
    outcome.grantNote !== null ||
    outcome.recordingNote !== null ||
    outcome.identityNote !== null
  ) {
    sendHtml(
      res,
      200,
      renderInstruct({
        csrf,
        grantNote: outcome.grantNote,
        recordingNote: outcome.recordingNote,
        identityNote: outcome.identityNote,
      }),
    );
    return;
  }
  redirect(res, '/');
}

/**
 * The instruction box, and every question still waiting on an answer (I3).
 *
 * This used to render the empty box with no lookup at all, which meant a
 * parked job's id and its question existed only in the HTML of the POST
 * response that created them: reload the page and the job was orphaned in
 * `understand`, a phase nothing in the scheduler touches, with no way for the
 * owner to see what they had been asked. Spec §8 says the question appears on
 * the dashboard with an answer box; until now it appeared in one HTTP
 * response and then ceased to exist.
 */
async function handleInstructGet(
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const waiting = await pendingQuestions({ businessId });
  // Boss commands waiting on confirmation, on either channel: the WhatsApp
  // collision refusal sends the owner here to answer (spec §10.11).
  const confirmations = await dashboardConfirmations({ businessId });
  sendHtml(
    res,
    200,
    renderInstruct({
      csrf: issueCsrfToken(session.sessionId),
      confirmations: confirmations.map((c) => ({
        jobId: c.jobId,
        question: c.presentedText,
        options: c.options.map((o) => ({ label: o.label, planHash: o.planHash })),
      })),
      pending: waiting.map((row) => ({
        jobId: row.jobId,
        question: row.question,
        text: row.text,
      })),
    }),
  );
}

/**
 * A fresh instruction from the box.
 *
 * **Deliberately not claimed the way the answer route is (I2).** There is
 * nothing here to claim: each POST is a distinct instruction with no
 * pre-existing row to key a lock on, and two submissions genuinely are two
 * instructions — the door's own rule, which `boss_instructions.job_id UNIQUE`
 * states in the schema. A double-click therefore opens two jobs, each with
 * its own instruction, grant and plan. That is a duplicate-work problem, not
 * a correctness one: neither job authorises anything the owner did not type,
 * and neither can fail the other, which was the whole of the answer route's
 * defect. Deduplicating a fresh submission needs an idempotency key minted
 * with the form, which is a larger change than this one.
 */
async function handleInstructPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const text = form.get('text') ?? '';

  // A forget command never reaches the planner. Erasure is not a tool and
  // must not become one by the back door of a plan step (spec §3), so the
  // branch is here — before `runInstruction`, which opens a job, grants a
  // standing authorisation and calls the model. Recognition is the
  // deterministic verb list in `forget-command.js`; it decides which screen
  // the text goes to and nothing about what will be deleted.
  const forget = readForgetCommand(text);
  if (forget.recognised) {
    // **Rendered here, never redirected to** (security review, MEDIUM). This
    // used to answer `303 /erase?identifier=<address>`, which wrote the
    // contact's address into the reverse proxy's access log — the deployment
    // mandates a proxy — and into the browser's history. Both outlive the
    // erasure, in two places it cannot reach, for a feature whose whole
    // promise is that the identity is gone and only counts remain. `onDate`
    // is less sensitive and travelled the same way.
    //
    // Answering in place is safe HERE specifically: a recognised forget
    // command creates no job, grants no authorisation and calls no model —
    // this branch returns before `runInstruction` — so there is no side
    // effect for Post/Redirect/Get to protect against on refresh. That
    // argument does NOT hold one line below, where the instruction path does
    // all three.
    //
    // The screen is built by the same function `GET /erase` uses, so the two
    // entrances cannot drift, and every form it emits posts to an absolute
    // path (`/erase/preview`, `/erase/confirm`, `/erase/keep`) so they work
    // unchanged from a page served at `/instruct`.
    return sendErasureScreenFor(res, businessId, session, documentRoot, {
      identifier: forget.identifier,
      onDate: forget.onDate,
    });
  }

  // `'typed'` is a statement of fact about this route, not a default: these
  // bytes arrived as an HTML form field from an authenticated owner session,
  // which is the owner's own keystrokes. The option is required precisely so
  // that every door has to say this out loud — the WhatsApp door is the one
  // that cannot (`whatsapp-door.ts`), because a voice note's text is a
  // transcription provider's output and nobody typed it.
  const outcome = await runInstruction(
    { text },
    { businessId, textOrigin: 'typed', channel: 'dashboard' },
  );
  await renderInstructionOutcome(res, session, outcome, businessId);
}

/**
 * The `job_steps.reason` recorded when the job parked on a clarifying
 * question is closed out after its answer produced a replacement job.
 *
 * Only ever called when `runInstruction` actually created one — `planned`
 * and `needs_answer` both carry a `jobId`, and the parameter type is
 * restricted to exactly that (`Extract<..., { jobId: string }>` drops
 * `refused`, which has no such field). A `refused` re-run never reaches
 * `createJob` — checked before this is ever invoked, in the phase guard and
 * the length/emptiness guards inside `handleInstructAnswer` — so there is
 * never a case where this function needs to say "no replacement exists";
 * that used to be a runtime branch here, and is now a compile-time
 * impossibility instead.
 *
 * Exported and pure so it can be tested without a network call or a
 * database — producing a genuine `planned` outcome through this HTTP route
 * would need a live model call this route has no way to inject around.
 */
/**
 * The `job_steps.reason` recorded when a refused re-run closes the parked job
 * out — task 12, fix round 1, Important 3. English, like every other reason in
 * this project, and distinct from `reasonForSupersededJob` above because the
 * two say different things to whoever reads the trail: that one names a
 * replacement, this one says there is none.
 *
 * Deliberately parallel to, and not imported from, the WhatsApp door's own
 * `REASON_ANSWER_REFUSED` (`src/orchestrator/whatsapp-routing.ts`): the two
 * doors should be distinguishable in the audit trail, which is the whole
 * reason each names itself in its own reason string.
 */
export const REASON_ANSWER_REFUSED_HERE =
  'instruction door: answer could not be planned; closed rather than left parked';

/**
 * Appended to the refusal the owner reads, so the sentence says what happened
 * to the previous request and not only that this attempt failed.
 *
 * Its own wording rather than the WhatsApp door's, for the same reason the
 * reason string above is: this one can point at the screen the owner is
 * already looking at.
 */
export const CLOSED_AFTER_REFUSAL_HERE =
  'סגרתי את הבקשה הקודמת כדי שלא תישאר פתוחה בלי שאף אחד יענה עליה. אפשר לכתוב אותה מחדש בתיבה למטה.';

export function reasonForSupersededJob(
  outcome: Extract<Awaited<ReturnType<typeof runInstruction>>, { jobId: string }>,
): string {
  return `instruction door: answered; superseded by ${outcome.jobId}`;
}

/**
 * Holds an exclusive claim on one parked job for the duration of `body`, or
 * returns `null` when someone else already holds it (I2).
 *
 * **Why a lock and not a transition.** Claiming by moving the job out of
 * `understand` would be one-way: `LEGAL_TRANSITIONS` (`src/domain/job.ts`)
 * names `understand` as a target from `intake` and from nowhere else, so a
 * claim-by-transition could never be undone — and every path that must leave
 * the job answerable, or decide what to do with it afterwards, would be
 * deciding it against a phase the route had already changed for its own
 * bookkeeping. A lock claims the *work* and is released whatever happens,
 * leaving the phase to mean only what it says.
 *
 * **Task 12, fix round 1, Important 3 rewrote the paragraph that used to sit
 * here, because the reason it gave had stopped being true.** It said a
 * refused re-run "deliberately leaves the parked job exactly where it was, so
 * the owner's obvious next move (shorten the answer, resubmit from the same
 * page) lands on a job still waiting" — but `recordAnswer` had already run by
 * then, so the job was no longer in `pendingQuestions` and `GET /instruct`
 * could not list it; the only route back to that form was the browser's own
 * Back button, and an owner who navigated away lost the question for good,
 * permanently parked and invisible. That is the instruction-silently-
 * disappears class, and the owner's principle is about INSTRUCTIONS, not
 * about one door. A refused re-run now CLOSES the parked job and says so,
 * which is what the WhatsApp door already does
 * (`whatsapp-routing.ts`'s `CLOSED_AFTER_REFUSAL`).
 *
 * **`pg_try_advisory_lock`, not the blocking form**, and for the reason
 * `conduct.ts` and `run-due.ts` give for theirs: the second request must be
 * turned away immediately with something the owner can read, never queued
 * behind a multi-second model call and then allowed to repeat it.
 *
 * **Session-scoped, on a client of its own.** The window this covers is a
 * live call to the Agent SDK. What that buys is narrower than it sounds:
 * `pg_try_advisory_lock` is session-scoped, not transaction-scoped, so the
 * connection itself is checked out of the pool for the whole call regardless
 * — a concurrent answer POST on a different job occupies its own connection
 * for as long as its model call runs, same as this one does. What is avoided
 * is an open *transaction* held across that call: no row locks, no held MVCC
 * snapshot, nothing blocking `VACUUM` for minutes while the network call
 * runs. The release mirrors `run-due.ts` exactly: a failed unlock hands the
 * connection back to `pg` as an error so the session is destroyed rather
 * than pooled while still holding the lock.
 */
async function withJobClaim<T>(
  scope: string,
  body: () => Promise<T>,
): Promise<{ claimed: true; value: T } | { claimed: false }> {
  const client = await getPool().connect();
  let holdsLock = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [scope],
    );
    if (lock.rows[0]?.locked !== true) return { claimed: false };
    holdsLock = true;
    return { claimed: true, value: await body() };
  } finally {
    if (holdsLock) {
      let unlockError: unknown;
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [scope]);
      } catch (error) {
        unlockError = error;
      }
      if (unlockError === undefined) {
        client.release();
      } else {
        client.release(unlockError instanceof Error ? unlockError : new Error(String(unlockError)));
      }
    } else {
      client.release();
    }
  }
}

/**
 * The reply to a clarifying question `runInstruction` asked.
 *
 * A job waiting on a question sits in the `understand` phase, which nothing
 * else in the system reads — `runDueJobs` only ever picks up jobs in
 * `execute`, and the scheduler has no notion of "answer pending". This route
 * is the only thing that ever acts on such a job again: it records the
 * answer, then re-runs the pipeline with the owner's answer appended to the
 * original text, exactly as if the owner had typed both in one go from the
 * start.
 *
 * **Only a job actually parked in `understand` may be answered** — checked
 * first, before `recordAnswer`, before `runInstruction`, before any
 * transition. An earlier version of this route skipped that check and
 * transitioned unconditionally, which broke two ways from the same line:
 *
 *   - A re-run that refuses (an over-length join, no active charter) used to
 *     close the ORIGINAL job out with `transition(… 'failed')` anyway, even
 *     though nothing replaced it — and then a second POST met a job already
 *     `failed`, where `failed → failed` is illegal: `transition` threw,
 *     uncaught, straight to the top-level 500 handler. The phase guard is
 *     what stops that, and it still does: the second POST is now refused with
 *     a sentence instead of throwing.
 *   - Nothing scoped this route to a job actually waiting for an answer —
 *     only to "a job in this business with an instruction row", which any
 *     successfully PLANNED instruction has too. A job sitting in `execute`
 *     qualifies, and `execute → failed` is a legal transition, so a POST here
 *     against the wrong job could overwrite its instruction's answer, open a
 *     redundant job, and fail an in-flight, already-authorised plan.
 *
 * The phase guard fixes both at once: a job already resolved into something
 * else is refused before anything is touched, and a second POST against a job
 * this route has already finished with gets a readable sentence rather than
 * an illegal transition.
 *
 * The re-run itself is always a **new** job, not a resumption of the parked
 * one — `runInstruction` calls `createJob` unconditionally — so the parked job
 * is always taken out of `understand`, and the two outcomes differ only in
 * how: `transition` to `failed` with `reasonForSupersededJob` when a
 * replacement exists to name (`planned`/`needs_answer`), and to `closed` with
 * `REASON_ANSWER_REFUSED_HERE` when the re-run refused and none does.
 * Resuming the parked job itself instead of superseding it would be a larger
 * change than this route carries.
 *
 * **Why `closed` on a refusal rather than leaving it parked — task 12, fix
 * round 1, Important 3.** The answer is recorded before the re-run, so a
 * parked job left behind is no longer in `pendingQuestions` and
 * `GET /instruct` cannot list it: the owner would be left with an instruction
 * that is permanently open, invisible on the screen built to show open ones,
 * and never reported. The owner's rule — an instruction stays open until one
 * side says clearly that it is finished — is about instructions, not about
 * one door, so this door says it, in Hebrew, the same way the WhatsApp door
 * already does. Closing a parked `understand` job cancels nothing: it has no
 * plan, spent nothing and never reached a step, so the cost is that the owner
 * retypes a request he can see he must retype.
 *
 * `loadInstructionForJob` is scoped to `businessId` and returns `null` for a
 * job that belongs to another business — indistinguishable, on purpose, from
 * a job id that never existed at all, the same reasoning `handleCard` already
 * applies to an approval id (both come back 404, never 403).
 */
async function handleInstructAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  jobId: string,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const instruction = await loadInstructionForJob(jobId, { businessId });
  if (instruction === null) return sendHtml(res, 404, renderNotFound());

  // Everything from the phase guard to the transition runs under one claim
  // on this job (I2). The guard is a read and `runInstruction` makes a live
  // model call before anything writes, so without this two POSTs — a
  // double-click, seconds apart — both passed the guard, both recorded an
  // answer, and both opened, granted, bound and promoted a job. Then both
  // closed the parked job out, and the second met a job already `failed`:
  // `failed → failed` is illegal, so `transition` threw uncaught to the 500
  // handler. Two authorised plans for one answer, and an error saying
  // nothing happened.
  const claim = await withJobClaim(`instruct-answer:${businessId}:${jobId}`, async () =>
    answerUnderClaim(res, businessId, session, jobId, instruction, form.get('answer') ?? ''),
  );
  if (!claim.claimed) {
    sendHtml(
      res,
      409,
      renderInstruct({
        csrf: issueCsrfToken(session.sessionId),
        error: 'התשובה הזו כבר בטיפול. רענן/י את הדף כדי לראות מה קרה.',
      }),
    );
  }
}

/** Said when a confirmation was already confirmed, cancelled or expired — by either channel. */
const CONFIRMATION_ALREADY_DECIDED = 'כבר טופל.';
/** Said when the posted `planHash` is not one the question offered; nothing moves. */
const CONFIRMATION_UNKNOWN_OPTION = 'האפשרות שנבחרה אינה אחת מהאפשרויות שהוצגו. לא שיניתי דבר.';

/**
 * The owner's answer to a boss-command confirmation, from the dashboard
 * (spec §4.3): a `planHash` he clicked, or `cancel=1`.
 *
 * CSRF first (403). The confirmation is loaded scoped to `businessId` — a job
 * of another business is a 404, like `handleInstructAnswer`'s. A posted
 * `planHash` must be among the STORED options, or the request is refused
 * (400) before anything moves: the button carries what was presented, and a
 * hash that was never presented is not something the owner confirmed.
 *
 * No WhatsApp freshness or strict-after check here: there is no inbound
 * message to date, `confirmChoice` enforces the window in SQL, and a question
 * presented on WhatsApp must be answerable here — the collision refusal sends
 * the owner here. A second POST meets `applyConfirmation`'s own guards (the
 * phase, then `UPDATE ... WHERE state = 'pending'`) and moves nothing.
 */
async function handleInstructConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  jobId: string,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const confirmation = await loadConfirmation(jobId, { businessId });
  if (confirmation === null) return sendHtml(res, 404, renderNotFound());

  const csrf = issueCsrfToken(session.sessionId);
  let reading: { kind: 'confirm'; planHash: string } | { kind: 'cancel' };
  if (form.get('cancel') === '1') {
    reading = { kind: 'cancel' };
  } else {
    const planHash = form.get('planHash') ?? '';
    if (!confirmation.options.some((option) => option.planHash === planHash)) {
      return sendHtml(res, 400, renderInstruct({ csrf, error: CONFIRMATION_UNKNOWN_OPTION }));
    }
    reading = { kind: 'confirm', planHash };
  }

  const outcome = await applyConfirmation(jobId, reading, `dashboard:${session.username}`, {
    businessId,
  });
  if (outcome === 'executing' || outcome === 'cancelled') return redirect(res, '/');
  sendHtml(res, 409, renderInstruct({ csrf, error: CONFIRMATION_ALREADY_DECIDED }));
}

/**
 * The body of `handleInstructAnswer`, run while this request holds the job's
 * claim — never called from anywhere else.
 *
 * Split out rather than inlined into the callback so the early returns below
 * read the same way they did before the claim existed: each one is a refusal
 * of this request, and every one of them releases the claim on the way out
 * through `withJobClaim`'s `finally`.
 */
async function answerUnderClaim(
  res: ServerResponse,
  businessId: string,
  session: Session,
  jobId: string,
  // Named fields rather than the whole `InstructionRecord`, as this
  // parameter has always been: it says exactly what this function reads off
  // the row. `textOrigin` joins the list because the re-plan below is over
  // the JOIN of `text` and `answer`, and a typed answer must not relabel a
  // recorded instruction as typed — see the call itself.
  instruction: { instructionId: string; text: string; textOrigin: InstructionTextOrigin },
  answer: string,
): Promise<void> {
  // Scoped to a job that is actually waiting on this answer — see
  // `handleInstructAnswer`'s docblock for the two ways skipping this check
  // broke. Read under the claim, so a concurrent request cannot move the
  // phase between this read and the transition at the end.
  const job = await loadJob(jobId, { businessId });
  if (job === null) return sendHtml(res, 404, renderNotFound());
  if (job.phase !== 'understand') {
    return sendHtml(
      res,
      400,
      renderInstruct({
        csrf: issueCsrfToken(session.sessionId),
        error: 'הבקשה הזו כבר אינה ממתינה לתשובה.',
      }),
    );
  }

  // The textarea's `required` is client-side only, and unlike `text` this
  // column carries no CHECK constraint bounding it — a hand-crafted POST can
  // send up to `MAX_BODY_BYTES` of it. An empty answer is worse than merely
  // unbounded: recorded as-is it overwrites any earlier answer, and re-runs
  // the pipeline on text byte-identical to the original instruction — so the
  // planner asks the very same question again, forever.
  if (answer.trim().length === 0) {
    return sendHtml(
      res,
      400,
      renderInstruct({ csrf: issueCsrfToken(session.sessionId), error: 'התשובה ריקה.' }),
    );
  }
  if (answer.length > MAX_INSTRUCTION_CHARS) {
    return sendHtml(
      res,
      400,
      renderInstruct({
        csrf: issueCsrfToken(session.sessionId),
        error: `התשובה ארוכה מ-${MAX_INSTRUCTION_CHARS} תווים.`,
      }),
    );
  }

  // `claimAnswer`, not a plain overwrite: a single `UPDATE ... WHERE answer IS
  // NULL` decides one writer. Redundant under the claim this runs inside, and
  // kept anyway — it is the only writer of this column left (task 12, fix
  // round 1), so the guard lives with the function rather than in the
  // assumption that every caller holds a lock. A `false` here means the row
  // was answered between the phase read above and this line.
  const took = await claimAnswer(instruction.instructionId, answer, { businessId });
  if (!took) {
    return sendHtml(
      res,
      409,
      renderInstruct({
        csrf: issueCsrfToken(session.sessionId),
        error: 'התשובה הזו כבר נרשמה. רענן/י את הדף כדי לראות מה קרה.',
      }),
    );
  }

  const outcome = await runInstruction(
    { text: `${instruction.text}\n\n${answer}` },
    {
      businessId,
      // The answer above was typed into this form, but the text being planned
      // is the JOIN of it and the parked instruction — and that instruction
      // can have arrived as a WhatsApp voice note, whose text nobody typed.
      // Positive, both halves: typed only if the stored half was typed too.
      // Without this read, a typed answer to a question raised by a recording
      // would launder the recorded half's addresses into "the owner typed
      // this himself" one hop later, which is the whole defect the origin
      // rule closes — reached through the dashboard rather than the door.
      textOrigin: instruction.textOrigin === 'typed' ? 'typed' : 'transcribed',
      // A confirmation question is answered where it was asked (boss
      // command, spec §4) — this is the dashboard.
      channel: 'dashboard',
      // Spec §7.2: asked once per chain — this is the second pass, so the
      // identity question is suppressed even if a name is still ambiguous.
      identityAsked: true,
    },
  );

  // The parked job always leaves `understand`; only the destination and the
  // reason differ. See this route's docblock on why a refusal CLOSES it
  // rather than leaving it parked — the answer is already recorded, so a job
  // left behind is open, invisible to `GET /instruct`, and never reported.
  if (outcome.status === 'refused') {
    await transition(jobId, {
      to: 'closed',
      actor: 'human',
      reason: REASON_ANSWER_REFUSED_HERE,
      businessId,
    });
    return sendHtml(
      res,
      400,
      renderInstruct({
        csrf: issueCsrfToken(session.sessionId),
        error: `${outcome.reason} ${CLOSED_AFTER_REFUSAL_HERE}`,
      }),
    );
  }

  await transition(jobId, {
    to: 'failed',
    actor: 'human',
    reason: reasonForSupersededJob(outcome),
    businessId,
  });

  await renderInstructionOutcome(res, session, outcome, businessId);
}

// --- The erasure screen (spec §4, §6, §7). --------------------------------
//
// Four routes, and one rule that outranks the rest: **the anchor travels,
// the plan never does.** `POST /erase/confirm` receives the same anchor the
// preview was drawn from and calls `buildErasurePlan` again, because a plan
// that went through a browser is a plan the browser could have edited, and
// `executeErasure` deletes exactly what its plan lists. Reconstructing an
// `ErasurePlan` from form fields here would hand the row list to whoever
// submitted the form.
//
// Erasure is reachable from nowhere else. It is not a tool, no agent
// allowlist names it, and no plan step can call it (spec §3) — the owner,
// on this screen, is the only path.

/**
 * A moment the owner typed, normalised to an ISO instant.
 *
 * Validated before it reaches SQL: `buildErasurePlan` puts the window
 * straight into a comparison against `jobs.created_at`, and an unparseable
 * string there is a database error surfacing as a 500 rather than a sentence
 * the owner can act on.
 */
const ErasureMoment = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());

/**
 * The three anchor shapes, parsed the same way whether they arrive from the
 * entry form or from the hidden field the preview page round-trips. Anything
 * else is refused with a readable sentence — never defaulted, and never
 * widened into "everything".
 */
const ErasureAnchorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contact'), identifier: z.string().trim().min(1) }),
  z.object({ kind: z.literal('window'), fromIso: ErasureMoment, toIso: ErasureMoment }),
  z.object({ kind: z.literal('document'), documentId: z.string().trim().min(1) }),
]);

const ANCHOR_UNREADABLE = 'לא הצלחתי לקרוא מה בדיוק למחוק. בחר/י שוב מהטופס.';
const KEEP_UNREADABLE = 'לא הצלחתי לקרוא איזה פריט לשמור.';

/** The kinds `kept_items` accepts, as a positive list this file can test against. */
const KEPT_KINDS: readonly KeptItemKind[] = ['document', 'memory', 'job'];

function keptKindFrom(raw: string | null): KeptItemKind | null {
  return KEPT_KINDS.find((kind) => kind === raw) ?? null;
}

function anchorFromForm(form: URLSearchParams): ErasureAnchor | null {
  const kind = form.get('kind');
  const candidate =
    kind === 'contact'
      ? { kind, identifier: form.get('identifier') ?? '' }
      : kind === 'window'
        ? { kind, fromIso: form.get('fromIso') ?? '', toIso: form.get('toIso') ?? '' }
        : kind === 'document'
          ? { kind, documentId: form.get('documentId') ?? '' }
          : null;
  if (candidate === null) return null;
  const parsed = ErasureAnchorInput.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * The anchor carried in a hidden field, parsed through the identical schema.
 *
 * A hand-edited field can therefore only ask for a *different preview* — the
 * screen answers it by resolving that anchor from scratch and showing the
 * counts again. It can never name rows of its own.
 */
function anchorFromJson(raw: string | null): ErasureAnchor | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ErasureAnchorInput.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A fingerprint of the plan the owner is looking at.
 *
 * Spec §4.4 makes the plan — not the anchor — the unit of authorisation. The
 * anchor may keep round-tripping through the browser (it is re-parsed and
 * re-resolved, so it can only ask for a different preview), but a confirm
 * must act on the plan whose counts the owner actually read: rebuilding and
 * then deleting means the destroyed set can be wider than the previewed one.
 *
 * The idiom is the one approvals already use — `input_hash` finds the row,
 * `input_hash_at_decision` proves it is the same thing that was decided, both
 * over `canonicalJson`. No table is added: the hash is the handle.
 *
 * **Normalised before hashing, deliberately.** The plan's id arrays come out
 * of `SELECT`s with no `ORDER BY` and out of `Set` iteration, so two builds
 * of an unchanged world may order them differently. Hashing the raw object
 * would make an identical world refuse at random — a control that fires when
 * nothing happened teaches the owner to click past it. Sorting first means a
 * difference in the hash is a difference in *what the plan covers*.
 *
 * For the same reason `excluded` is reduced to `itemKind:itemId` and its
 * `keptAt` and `note` are **display-only, deliberately outside the hash**: a
 * kept item's id is already subtracted from `jobIds`/`documentIds`/
 * `memoryIds` before the plan is returned, so a change to *when* or *why*
 * something was kept cannot move a single row the executor touches. Editing a
 * note between the preview and the confirm re-renders identically, which is
 * the right outcome.
 */
function planFingerprint(plan: ErasurePlan): string {
  return canonicalHash({
    anchor: plan.anchor,
    jobIds: [...plan.jobIds].sort(),
    documentIds: [...plan.documentIds].sort(),
    memoryIds: [...plan.memoryIds].sort(),
    digestIds: [...plan.digestIds].sort(),
    mailIds: [...plan.mailIds].sort(),
    filePaths: [...plan.filePaths].sort(),
    items: plan.items.map((item) => `${item.table}:${item.action}:${item.count}`).sort(),
    excluded: plan.excluded.map((k) => `${k.itemKind}:${k.itemId}`).sort(),
    refusals: plan.refusals.map((r) => `${r.kind}:${r.detail}`).sort(),
  });
}

const PLAN_MOVED =
  'מה שנמצא למחיקה השתנה מאז שהצגתי לך את הרשימה, ולכן לא מחקתי כלום. ' +
  'זו הרשימה המעודכנת — עבור/י עליה ואשר/י שוב.';

function anchorLabelFor(anchor: ErasureAnchor): string {
  switch (anchor.kind) {
    case 'contact':
      return anchor.identifier;
    case 'document':
      return anchor.documentId;
    case 'window':
      return `${anchor.fromIso} — ${anchor.toIso}`;
  }
}

/** Keeps the entry form showing the anchor the preview was built from. */
function prefillFor(anchor: ErasureAnchor): ErasurePrefill {
  switch (anchor.kind) {
    case 'contact':
      return { identifier: anchor.identifier };
    case 'document':
      return { documentId: anchor.documentId };
    case 'window':
      return { fromIso: anchor.fromIso, toIso: anchor.toIso };
  }
}

/**
 * The entry form on its own, with an optional sentence saying what went wrong.
 *
 * It also carries the kept list. Spec §6 says every erasure screen shows what
 * is kept, and this screen has no plan and so no `plan.excluded` to render —
 * a keep the owner set last month was invisible here until they happened to
 * build a preview that reached it.
 */
async function sendErasureEntry(
  res: ServerResponse,
  businessId: string,
  session: Session,
  status: number,
  overrides: { error?: string; prefill?: ErasurePrefill } = {},
): Promise<void> {
  sendHtml(
    res,
    status,
    renderErasure({
      csrf: issueCsrfToken(session.sessionId),
      anchorLabel: '',
      plan: null,
      kept: await listKept({ businessId }),
      ...(overrides.error === undefined ? {} : { error: overrides.error }),
      ...(overrides.prefill === undefined ? {} : { prefill: overrides.prefill }),
    }),
  );
}

/**
 * Resolve the anchor and show what would be destroyed. Read-only, always:
 * `buildErasurePlan` runs nothing but SELECTs, so a preview — including one
 * reached by a hand-written URL — cannot change a row.
 */
async function sendErasurePreview(
  res: ServerResponse,
  businessId: string,
  session: Session,
  anchor: ErasureAnchor,
  documentRoot: string | undefined,
  overrides: { plan?: ErasurePlan; error?: string } = {},
): Promise<void> {
  const plan = overrides.plan ?? (await resolvePlan(anchor, businessId, documentRoot));
  sendHtml(
    res,
    200,
    renderErasure({
      csrf: issueCsrfToken(session.sessionId),
      anchorLabel: anchorLabelFor(anchor),
      plan,
      planHash: planFingerprint(plan),
      prefill: prefillFor(anchor),
      ...(overrides.error === undefined ? {} : { error: overrides.error }),
    }),
  );
}

/**
 * One place the plan is built, so the preview and the confirm cannot drift on
 * which document root they resolved file paths against — the paths are what
 * the executor `unlink`s, and a fingerprint over a different root is a
 * fingerprint of a different plan.
 */
async function resolvePlan(
  anchor: ErasureAnchor,
  businessId: string,
  documentRoot: string | undefined,
): Promise<ErasurePlan> {
  return buildErasurePlan(anchor, {
    businessId,
    ...(documentRoot === undefined ? {} : { documentRoot }),
  });
}

/**
 * The screen itself. `?identifier=` arrives from a forget command and goes
 * straight to a preview; `?onDate=` only fills the window fields in, because
 * "which of the three tasks that ran that day" is a choice the owner makes
 * from a list, not one this route guesses (spec §4.2).
 */
async function handleEraseGet(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
): Promise<void> {
  const params = new URL(req.url ?? '/erase', 'http://dashboard.local').searchParams;
  await sendErasureScreenFor(res, businessId, session, documentRoot, {
    identifier: params.get('identifier'),
    onDate: params.get('onDate'),
  });
}

/**
 * The erasure screen for what a forget command could read out of the text.
 *
 * One path, so `GET /erase?identifier=` and the inline render from
 * `POST /instruct` cannot answer the same prefill with two different screens.
 * An identifier goes straight to a preview; a date only fills the window
 * fields in, because "which of the three tasks that ran that day" is a choice
 * the owner makes from a list, not one this route guesses (spec §4.2).
 */
async function sendErasureScreenFor(
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
  prefill: { identifier: string | null; onDate: string | null },
): Promise<void> {
  const identifier = (prefill.identifier ?? '').trim();
  if (identifier !== '') {
    return sendErasurePreview(res, businessId, session, { kind: 'contact', identifier }, documentRoot);
  }

  const onDate = prefill.onDate ?? '';
  const window: ErasurePrefill = /^\d{4}-\d{2}-\d{2}$/.test(onDate)
    ? { fromIso: `${onDate}T00:00`, toIso: `${onDate}T23:59` }
    : {};
  await sendErasureEntry(res, businessId, session, 200, { prefill: window });
}

async function handleErasePreview(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const anchor = anchorFromForm(form);
  if (anchor === null)
    return sendErasureEntry(res, businessId, session, 400, { error: ANCHOR_UNREADABLE });
  await sendErasurePreview(res, businessId, session, anchor, documentRoot);
}

/**
 * The irreversible one.
 *
 * The plan is **rebuilt from the anchor** and never reconstructed from the
 * form — see the block comment above. The rebuild also re-runs the refusals,
 * which is what catches a job the scheduler woke into a live phase while the
 * owner was reading the preview; `executeErasure` checks the same thing again
 * under a row lock, and that second refusal is caught here rather than
 * becoming a 500.
 */
async function handleEraseConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const anchor = anchorFromJson(form.get('anchor'));
  if (anchor === null)
    return sendErasureEntry(res, businessId, session, 400, { error: ANCHOR_UNREADABLE });

  const plan = await resolvePlan(anchor, businessId, documentRoot);
  // A refusal first: it is the more useful thing to say, and it is true
  // whether or not the plan also moved.
  if (plan.refusals.length > 0) {
    return sendErasurePreview(res, businessId, session, anchor, documentRoot, { plan });
  }

  // Then the handshake. The owner authorised a set of counts, not an anchor;
  // if the rebuilt plan is not the one they read, re-show it instead of
  // destroying a wider set than the preview named (spec §4.4). A missing
  // hash lands here too — nothing was authorised.
  if (form.get('planHash') !== planFingerprint(plan)) {
    return sendErasurePreview(res, businessId, session, anchor, documentRoot, {
      plan,
      error: PLAN_MOVED,
    });
  }

  let outcome: ErasureOutcome;
  let auditUnrecorded = false;
  try {
    outcome = await executeErasure(plan, { businessId });
  } catch (error) {
    // It happened. The transaction committed and every unlink was attempted;
    // only the record of it is missing, and reporting that as a failure
    // would tell the owner their data is still there when it is not.
    if (error instanceof ErasureAuditUnrecordedError) {
      outcome = error.outcome;
      auditUnrecorded = true;
    } else if (error instanceof ErasureRefusedError) {
      // The window the plan-time check cannot close: a job went live between
      // the rebuild above and the executor's locked re-read. Nothing was
      // deleted — show why, with the confirm control gone.
      // `error.kind` and not a hardcoded `live_job`: the executor refuses for
      // two reasons (a job woken live, and a document signed since the
      // preview), and the rebuilt plan below already names the specific
      // document or job underneath this sentence.
      const refreshed = await resolvePlan(anchor, businessId, documentRoot);
      return sendErasurePreview(res, businessId, session, anchor, documentRoot, {
        plan: {
          ...refreshed,
          refusals: [{ kind: error.kind, detail: error.message }, ...refreshed.refusals],
        },
      });
    } else {
      throw error;
    }
  }

  sendHtml(
    res,
    200,
    renderErasureDone({
      anchorLabel: anchorLabelFor(anchor),
      // The plan's own count, not the outcome's: it is the denominator the
      // screen needs to notice that it deleted none of what it named.
      plannedFiles: plan.filePaths.length,
      outcome,
      auditUnrecorded,
    }),
  );
}

/**
 * "Keep this" and "stop keeping this" — the one list an erasure does not
 * touch (spec §6).
 *
 * Both directions answer with the preview rebuilt from the same anchor, so
 * the owner sees the item leave the plan, or come back into it, in the same
 * response as the click.
 */
async function handleEraseKeep(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  documentRoot: string | undefined,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const kind = keptKindFrom(form.get('kind'));
  const itemId = (form.get('itemId') ?? '').trim();
  if (kind === null || itemId === '')
    return sendErasureEntry(res, businessId, session, 400, { error: KEEP_UNREADABLE });

  if (form.get('revoke') === '1') {
    await revokeKeep(kind, itemId, { businessId });
  } else {
    const note = noteFrom(form);
    await keepItem({ kind, itemId, ...(note === undefined ? {} : { note }) }, { businessId });
  }

  const anchor = anchorFromJson(form.get('anchor'));
  if (anchor === null) return sendErasureEntry(res, businessId, session, 200);
  await sendErasurePreview(res, businessId, session, anchor, documentRoot);
}


async function handleCard(res: ServerResponse, businessId: string, session: Session, approvalId: string): Promise<void> {
  // Scoped by businessId in the same query that loads the row — an approval
  // belonging to another business must not be distinguishable from one that
  // does not exist at all, so both come back 404, never 403.
  const approval = await getApproval(approvalId, { businessId });
  if (!approval) return sendHtml(res, 404, renderNotFound());
  // `null` (no document behind this approval) is the ordinary case — most
  // approvals never had a document. When one does resolve, the card shows it
  // either way; the sign form is a second, narrower question, answered by the
  // proposal's own intent against `DOCUMENT_DECISION_INTENTS` (I4).
  const resolved = await documentForApproval(approvalId, { businessId });
  // Read at REQUEST time, deliberately — the same reasoning `documentForApproval`
  // already carries a level up. Whether `gov.verify`'s own job has finished by
  // now, or was even opened, is not something this route waits on or cares
  // about: no verdict is a state the card already renders correctly.
  //
  // Fix round 1, Important 4: `Verdict.parse` / `NotJudgedReason.parse`
  // (inside `loadVerificationOutcome`) throw on a row that fails to validate,
  // and this route is the ONLY thing standing between that row and the
  // owner's entire decision surface — approve, deny, edit, note AND sign all
  // render through this one function, and an unguarded throw here would take
  // all of them down with a generic 500 over a single bad column. Caught
  // here, and rendered as "unreadable" rather than "absent" — the owner is
  // told a verdict exists but could not be shown, not led to believe none
  // was ever produced.
  //
  // Task 5: `loadVerificationOutcome` replaces `loadVerdict` so the card can
  // tell apart the three states it distinguishes: `judged` (a verdict),
  // `not_judged` (attempted and did not finish, with a reason), and `null`
  // (nothing written yet — still running). The catch above still covers a
  // row that fails to parse in either shape.
  let verdict: Verdict | null = null;
  let notJudgedReason: NotJudgedReason | null = null;
  let verdictUnreadable = false;
  if (approval.jobId !== null) {
    try {
      const outcome = await loadVerificationOutcome(approval.jobId, { businessId });
      if (outcome !== null) {
        if (outcome.status === 'judged') {
          verdict = outcome.verdict;
        } else {
          notJudgedReason = outcome.reason;
        }
      }
    } catch {
      verdictUnreadable = true;
    }
  }
  sendHtml(
    res,
    200,
    renderApprovalCard({
      approval,
      csrf: issueCsrfToken(session.sessionId),
      ...(resolved !== null
        ? { document: resolved.document, documentIntent: resolved.intent }
        : {}),
      ...(verdict !== null ? { verdict } : {}),
      ...(notJudgedReason !== null ? { notJudged: notJudgedReason } : {}),
      ...(verdictUnreadable ? { verdictUnreadable: true } : {}),
      ...(await mailReplyOptions(approval.jobId, businessId)),
    }),
  );
}

/** The card options a mailbox reply needs: the marker, and the provider when one is bound. */
async function mailReplyOptions(
  jobId: string | null,
  businessId: string,
): Promise<{ mailReply?: true; mailProvider?: string }> {
  if (!(await isMailReplyCard(jobId, businessId))) return {};
  const mailProvider = await mailboxProviderOf(businessId);
  return mailProvider !== null ? { mailReply: true, mailProvider } : { mailReply: true };
}

/** The provider on the business's `mailbox` binding, or `null` when none is bound. */
async function mailboxProviderOf(businessId: string): Promise<string | null> {
  const bindings = await loadBindings({ businessId });
  return bindings.find((b) => b.system === MAILBOX_SYSTEM)?.provider ?? null;
}

/** The positive marker the reply layout and the reply edit rule key on. */
async function isMailReplyCard(jobId: string | null, businessId: string): Promise<boolean> {
  return jobId !== null && (await isMailReplyJob(jobId, { businessId }));
}

/** JSON.parse can hand back an object, an array, a string, a number, a boolean, or null — only the first is a tool payload. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The edited payload, if the owner changed anything, from the approve form's
 * `input` field.
 *
 * Three outcomes:
 *   - `{ ok: true, editedInput: undefined }` — field absent (the deny form
 *     carries no `input` at all) or present but byte-for-byte the same
 *     proposal reformatted. `canonicalHash` is what makes the second case
 *     safe: it sorts keys and drops insignificant whitespace, so a
 *     round-trip through the textarea that changed nothing but key order
 *     does not get treated as an edit. Without that, `decide` would stamp
 *     `approved_with_edit` on every approval that merely passed through this
 *     form, and "edited" would stop meaning anything.
 *   - `{ ok: true, editedInput: <value> }` — parsed JSON, and a plain object,
 *     that hashes differently from the stored proposal. This is what makes
 *     it into `Decision.editedInput`.
 *   - `{ ok: false, raw }` — the text failed to parse as JSON, or parsed to
 *     something other than a plain object. `raw` is handed back to the
 *     caller so the card can be re-rendered with exactly what the owner
 *     typed, not a silently-reverted original; the approval is left
 *     untouched (`decide` is never called).
 *
 * The object check is not decoration. `PlanStep.input` is
 * `z.record(z.string(), z.unknown())` — a tool payload is an object
 * everywhere else in this system — and `null` in particular is a trap: it
 * passes `JSON.parse`, `decide` binds `canonicalHash(null)` and stamps
 * `approved_with_edit`, and then `execute.ts`'s `editedInput !== null` guard
 * refuses to run it — so the ORIGINAL input runs instead, its hash no longer
 * matches the one the approval was just re-bound to, and the step re-queues
 * forever behind an audit row that claims an edit was applied. A scalar or
 * array would get past that guard and into a `Record<string, unknown>` cast
 * that is a lie about the shape. Rejecting anything but a plain object here,
 * at the one place a person can type into this value, is what stops both.
 */
/**
 * Deliberately the same schema as `PlanStep.input` (`src/domain/plan.ts`), not
 * a lookalike. Both describe "a tool payload a human or a model proposed", and
 * the only reason this route was exploitable is that it had no schema while the
 * plan route did. Two shapes for one concept is how they drift apart again.
 */
const EDITED_INPUT = z.record(z.string(), z.unknown());

export function parseEditedInput(
  raw: string | null,
  originalInputHash: string,
): { ok: true; editedInput?: unknown } | { ok: false; raw: string } {
  if (raw === null) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, raw };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, raw };
  }
  // Sanitised by the SAME schema `PlanStep.input` uses (`src/domain/plan.ts`),
  // and that is the whole point: this was the one route into the gate with no
  // schema behind it. `JSON.parse` makes `__proto__` an ordinary own property,
  // and `isPlainObject` has no opinion about it — so it survived into
  // `edited_input`, through the JSONB round-trip, into `effectiveInput`, and
  // reached the gate, where redaction turned it into a prototype that the mail
  // adapter reads and the gate's own recipient reader cannot. zod drops the
  // key, so the payload that gets hashed here is exactly the payload that runs.
  const sanitised = EDITED_INPUT.safeParse(parsed);
  if (!sanitised.success) return { ok: false, raw };
  const edited = sanitised.data;
  if (canonicalHash(edited) === originalInputHash) return { ok: true };
  return { ok: true, editedInput: edited };
}

/**
 * Hebrew refusal text for every `VerifyOutcome` except `unchanged` — the one
 * outcome that lets signing proceed at all, so it is never asked to explain
 * itself. `missing` and `unreadable` read differently on purpose (see
 * `verify.ts`'s own header): one says the file is gone, the other says the
 * deployment cannot read it and names the OS error code, because those point
 * an operator at two different problems.
 */
function signRefusalReason(outcome: Exclude<VerifyOutcome, { status: 'unchanged' }>): string {
  switch (outcome.status) {
    case 'changed':
      return 'תוכן הקובץ השתנה מאז שנקרא לראשונה. יש לבדוק את הגרסה העדכנית לפני שחותמים עליה.';
    case 'missing':
      return 'הקובץ שעליו מבוססת הבקשה נעדר מהדיסק. יש לוודא שהוא לא נמחק ולנסות שוב.';
    case 'unreadable':
      return `לא ניתן היה לקרוא את הקובץ השמור (שגיאה: ${outcome.cause}). זו כנראה תקלת הרשאות בפריסה ולא מחיקה של הקובץ — יש לפנות לגורם טכני.`;
    case 'unknown_document':
      return 'המסמך שעליו מבוססת הבקשה אינו נמצא. לא ניתן לחתום.';
  }
}

/**
 * When and by whom, in the refusal itself (spec §8: "the uniqueness holds,
 * and the message says when and who").
 *
 * "The document is already signed" alone tells the owner that something
 * happened and gives them no way to find out what — they would have to ask
 * whoever runs the database. `loadSignature` returning `null` here means the
 * row vanished between the unique violation and this read, which is a
 * genuinely strange state and not one to invent a name and a date for.
 *
 * The timestamp is formatted in the process's own timezone: this dashboard is
 * a single-tenant install run for one business, so the server's clock is the
 * owner's clock, and an ISO string in UTC would be the honest-looking answer
 * to a question nobody asked.
 */
function alreadySignedReason(signature: SignatureRecord | null): string {
  if (signature === null) {
    return 'המסמך כבר נחתם בעבר. אין צורך לחתום שוב.';
  }
  const when = new Intl.DateTimeFormat('he-IL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(signature.signedAt));
  return `המסמך כבר נחתם בתאריך ${when} על ידי ${signature.signedBy}. אין צורך לחתום שוב.`;
}

async function handleDecision(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  approvalId: string,
  outcome: 'approved' | 'denied' | 'signed',
  documentRoot: string | undefined,
): Promise<void> {
  let form: URLSearchParams;
  try {
    form = await readFormBody(req);
  } catch (err) {
    if (!(err instanceof FormBodyTooLargeError)) throw err;
    // The body was too large to buffer at all, so there is no raw text to
    // hand back — unlike the malformed-JSON case, the edit itself is what
    // has to be given up here. The card still needs a live CSRF token and
    // a session, exactly as the plain approve/deny path does; nothing about
    // this error path skips either check.
    const approval = await getApproval(approvalId, { businessId });
    if (!approval) return sendHtml(res, 404, renderNotFound());
    return sendHtml(
      res,
      400,
      renderApprovalCard({
        approval,
        csrf: issueCsrfToken(session.sessionId),
        error: 'התוכן שנשלח גדול מדי לשמירה. יש לקצר את העריכה ולנסות שוב.',
      }),
    );
  }

  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const approval = await getApproval(approvalId, { businessId });
  if (!approval) return sendHtml(res, 404, renderNotFound());

  const note = noteFrom(form);

  // A `signed` outcome does everything `approved` does, and first: refuses
  // unless the approval is still open, a real document backs this request,
  // that document is the one the sign form actually named, and re-verifying
  // its bytes on disk finds them unchanged — and only then records the
  // signature, its audit row and the approval decision, which
  // `decideAndSign` commits as one transaction or not at all (F1).
  //
  // What the refusals below actually guarantee, stated exactly: each of them
  // re-renders the card, leaves the approval `pending`, and writes nothing.
  // What runs AFTER them does not have that shape — `decideAndSign` decides
  // the approval, and it can still throw. The guarantee that replaces
  // "never throws" is atomicity: whatever it throws, no signature row, no
  // audit row and no decision survives it, so the owner can fix the problem
  // and try again on an approval that is exactly where they left it.
  // `DocumentAlreadySignedError` and `ApprovalNotDecidableError` are caught
  // and rendered as refusals; anything else is a real fault and becomes a
  // 500. Errors from this block go on `signError`, not `error`: `error`
  // renders inside the approve form, and a refusal about the document being
  // signed does not belong attached to a different control (see `signForm`'s
  // docblock).
  if (outcome === 'signed') {
    // I1: mirrors exactly what `decide` (called via `applyDecision` below)
    // itself refuses — `state !== 'pending'` and an expired `expiresAt` —
    // checked here, before anything below runs. Without this, a stale tab
    // could still verify the file, record a signature and write its audit
    // row before `decide` finally threw on an approval that was already
    // denied (or timed out) in another tab: the signature would then be
    // real and permanent — `signatures_one_per_document_idx` allows exactly
    // one per document — over a decision the owner never actually made.
    if (approval.state !== 'pending' || Date.parse(approval.expiresAt) <= Date.now()) {
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          ...(note !== undefined ? { noteValue: note } : {}),
          signError: 'הבקשה כבר הוכרעה או שפג תוקפה, ולא ניתן לחתום עליה כעת.',
        }),
      );
    }

    const resolved = await documentForApproval(approvalId, { businessId });
    if (resolved === null) {
      // The button that posts here would not have been rendered without a
      // document — a direct POST is a stale page or someone probing.
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          ...(note !== undefined ? { noteValue: note } : {}),
          signError: 'לא נמצא מסמך המשויך לבקשה זו. לא ניתן לחתום.',
        }),
      );
    }
    const { document } = resolved;

    // I4: the same allowlist the card renders by, enforced again here. A
    // control that only removes a button is a control an old tab, a bookmark
    // or a hand-written POST walks straight past — and what is on the other
    // side of it is a `signatures` row that is unique per document and
    // protected by `ON DELETE RESTRICT`, so there is no undo to fall back on.
    // Checked before the file is read and hashed: nothing about this refusal
    // needs to touch the disk.
    if (!isDocumentDecisionIntent(resolved.intent)) {
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          document,
          documentIntent: resolved.intent,
          ...(note !== undefined ? { noteValue: note } : {}),
          signError:
            'הבקשה הזו אינה הכרעה על המסמך עצמו, ולכן לא ניתן לחתום עליה. אפשר לאשר או לדחות אותה כרגיל.',
        }),
      );
    }

    // M4: the sign form carries a hidden `documentId` naming the document it
    // was rendered with. `documentForApproval`'s ordering has no tiebreaker
    // for two proposals sharing a `created_at` (fixed alongside this, in
    // `document-for-approval.ts`), and this route resolves the document a
    // second, independent time — so without this check the two resolutions
    // could disagree, and the signature would attest to a document the
    // owner never saw on screen.
    if (form.get('documentId') !== document.documentId) {
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          document,
          documentIntent: resolved.intent,
          ...(note !== undefined ? { noteValue: note } : {}),
          signError: 'המסמך המוצג אינו תואם עוד את הבקשה. יש לרענן את הדף ולנסות שוב.',
        }),
      );
    }

    const verifyResult = await verifyDocumentUnchanged(document.documentId, {
      businessId,
      ...(documentRoot !== undefined ? { documentRoot } : {}),
    });
    if (verifyResult.status !== 'unchanged') {
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          document,
          documentIntent: resolved.intent,
          ...(note !== undefined ? { noteValue: note } : {}),
          signError: signRefusalReason(verifyResult),
        }),
      );
    }

    // `verifyResult.sha256` — what verification just measured — not
    // `document.sha256`: the whole point of re-hashing is to sign the bytes
    // actually on disk right now, not the row's stale claim about them.
    //
    // I3: the audit reason is English, in the `verb_noun:<id>` prefix form
    // every other production `appendAudit` call site in the repo already uses
    // (`engine.ts`, `killswitch.ts`, `bindings.ts`, `recovery.ts`) —
    // `audit_log.reason` is a forensic field nothing in the dashboard,
    // `render.ts` or the CLI ever displays, so it is not covered by
    // CLAUDE.md's "Hebrew for what the owner reads" rule. `originalName` is
    // deliberately left out: it is a sender-chosen string, and no other audit
    // reason in the repo carries attacker-influenced free text.
    let decided: ApprovalRequest;
    try {
      decided = await decideAndSign(
        {
          approvalId,
          decision: {
            by: session.username,
            channel: 'dashboard',
            ...(note !== undefined ? { note } : {}),
          },
          signature: {
            signatureId: `SIG-${ulid()}`,
            documentId: document.documentId,
            signedSha256: verifyResult.sha256,
            approvalId,
            signedBy: session.username,
          },
          audit: {
            ...(approval.jobId !== null ? { jobId: approval.jobId } : {}),
            actor: 'human',
            onBehalfOf: session.username,
            kind: 'signature',
            charterVersion: 'unknown',
            provenance: 'boss',
            inputHash: canonicalHash({
              documentId: document.documentId,
              approvalId,
              sha256: verifyResult.sha256,
            }),
            reason: `signature:${document.documentId} by ${session.username} for approval ${approvalId}`,
          },
        },
        { businessId },
      );
    } catch (err) {
      if (err instanceof DocumentAlreadySignedError) {
        const existing = await loadSignature(document.documentId, { businessId });
        return sendHtml(
          res,
          400,
          renderApprovalCard({
            approval,
            csrf: issueCsrfToken(session.sessionId),
            document,
            documentIntent: resolved.intent,
            ...(note !== undefined ? { noteValue: note } : {}),
            signError: alreadySignedReason(existing),
          }),
        );
      }
      if (err instanceof ApprovalNotDecidableError) {
        // The guard above read `state` and `expires_at`; a document join, a
        // file read and a SHA-256 later, `decide`'s own predicate disagreed.
        // Nothing was written — that is what `decideAndSign` guarantees — so
        // this is the same refusal the guard renders, not a fault.
        return sendHtml(
          res,
          400,
          renderApprovalCard({
            approval,
            csrf: issueCsrfToken(session.sessionId),
            document,
            documentIntent: resolved.intent,
            ...(note !== undefined ? { noteValue: note } : {}),
            signError: 'הבקשה כבר הוכרעה או שפג תוקפה, ולא ניתן לחתום עליה כעת.',
          }),
        );
      }
      throw err;
    }

    // The job-phase half of `applyDecision`, run after the signature
    // transaction commits: `transition` opens its own transaction and takes
    // `FOR UPDATE` on the job row, so it cannot join the one above.
    await resumeAfterDecision(decided, session.username, { businessId });
    return redirect(res, '/');
  }

  // Only the approve form carries an editable payload — denying something,
  // and signing (which runs the ordinary approve path unedited, on exactly
  // what was proposed), do not need a version of it to run, so those posts
  // are treated as if `input` were never sent, whatever a hand-crafted
  // request attaches.
  const edit = parseEditedInput(
    outcome === 'approved' ? form.get('input') : null,
    approval.inputHash,
  );

  const mailReply = await isMailReplyCard(approval.jobId, businessId);
  const mailProvider = mailReply ? await mailboxProviderOf(businessId) : null;
  const providerOption = mailProvider !== null ? { mailProvider } : {};

  if (!edit.ok) {
    return sendHtml(
      res,
      400,
      renderApprovalCard({
        approval,
        csrf: issueCsrfToken(session.sessionId),
        editValue: edit.raw,
        ...(note !== undefined ? { noteValue: note } : {}),
        ...(mailReply ? { mailReply: true } : {}),
        ...providerOption,
        error: 'התוכן שהוזן אינו אובייקט JSON תקין. יש להזין מבנה בסגנון { "שדה": ערך } ולנסות שוב.',
      }),
    );
  }

  // A mailbox reply goes to the original From, always (mailbox spec 5.2):
  // only the subject and the body may be edited — and on a Microsoft 365
  // mailbox only the body, since Outlook sets the reply subject itself (R22).
  // Keyed on the marker OR the reply shape of what was proposed -- the
  // refusal only ever narrows, so the broader test is the safe one -- and
  // checked before `decide`, so the approval stays pending and nothing can run.
  const editRefusal =
    edit.editedInput !== undefined &&
    (mailReply || mailboxReplyRecipient(approval.proposedInput) !== null)
      ? mailReplyEditRefusal(
          approval.proposedInput,
          edit.editedInput,
          mailProvider ?? (await mailboxProviderOf(businessId)),
        )
      : null;
  if (editRefusal !== null) {
    return sendHtml(
      res,
      400,
      renderApprovalCard({
        approval,
        csrf: issueCsrfToken(session.sessionId),
        editValue: JSON.stringify(edit.editedInput, null, 2),
        ...(note !== undefined ? { noteValue: note } : {}),
        ...(mailReply ? { mailReply: true } : {}),
        ...providerOption,
        error: editRefusal,
      }),
    );
  }

  await applyDecision(
    approvalId,
    // `applyDecision` only knows 'approved' | 'denied' — a signature is an
    // extra act performed before this, not a third outcome it records itself.
    outcome === 'denied' ? 'denied' : 'approved',
    {
      by: session.username,
      channel: 'dashboard',
      ...(note !== undefined ? { note } : {}),
      ...(edit.editedInput !== undefined ? { editedInput: edit.editedInput } : {}),
    },
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

/**
 * The learning level, or `null` when it cannot be read. The screen is how the
 * owner turns the dial and picks update channels, so a charter this code
 * cannot read (or none at all) must cost him the score, not the page.
 */
async function readLearning(businessId: string): Promise<LearningSnapshot | null> {
  try {
    return await learningSnapshot({ businessId });
  } catch {
    return null;
  }
}

async function renderAutonomyScreen(
  res: ServerResponse,
  businessId: string,
  session: Session,
  status: number,
  error?: string,
  settings?: ActionUpdateSettings,
): Promise<void> {
  const mode = await loadAutonomyMode({ businessId });
  const shown = settings ?? (await loadActionUpdateSettings({ businessId }));
  sendHtml(
    res,
    status,
    renderAutonomy(mode, await readLearning(businessId), shown, issueCsrfToken(session.sessionId), error),
  );
}

/**
 * The owner's dial (spec §8.4), the learning level above it and the update
 * channels below it (shadow mode, spec §5.3, §5.5). GET shows them; the two
 * POSTs change the dial and the channels.
 */
async function handleAutonomyGet(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  await renderAutonomyScreen(res, businessId, session, 200);
}

async function handleAutonomyModePost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const parsed = AutonomyMode.safeParse(form.get('mode'));
  if (!parsed.success) {
    return renderAutonomyScreen(res, businessId, session, 400, 'יש לבחור אחת משלוש האפשרויות.');
  }

  await setAutonomyMode(parsed.data, session.username, { businessId });
  redirect(res, '/autonomy');
}

/**
 * Where the per-action updates go. All three unchecked is refused by
 * `saveActionUpdateSettings` itself, before it writes; the screen is
 * re-rendered with its sentence and with the boxes as the owner left them,
 * so he sees what was refused rather than the old choice silently restored.
 */
async function handleAutonomyUpdatesPost(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const settings: ActionUpdateSettings = {
    toWhatsApp: form.get('toWhatsApp') === 'on',
    toEmail: form.get('toEmail') === 'on',
    toScreen: form.get('toScreen') === 'on',
  };
  try {
    await saveActionUpdateSettings(settings, { businessId, updatedBy: session.username });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return renderAutonomyScreen(res, businessId, session, 400, message, settings);
  }
  redirect(res, '/autonomy');
}

/**
 * What the assistant did on its own (spec §8.5). GET lists it; POST records
 * that one step was wrong.
 *
 * With the screen chosen as an update channel, rows whose update the owner
 * has not seen are marked "חדש", and exactly those rows are then marked
 * seen — after the page is rendered, so the mark is what he was shown.
 */
async function handleAutonomousActionsGet(res: ServerResponse, businessId: string, session: Session): Promise<void> {
  const actions = await listAutonomousActions({ businessId });
  const settings = await loadActionUpdateSettings({ businessId });
  const fresh = settings.toScreen ? await unseenUpdateKeys(actions, { businessId }) : new Set<string>();
  const html = renderAutonomousActions(actions, issueCsrfToken(session.sessionId), undefined, fresh);
  await markUpdatesSeen(fresh, { businessId });
  sendHtml(res, 200, html);
}

/**
 * Records a correction — never an undo. `recordCorrection` (T5) both writes
 * the `autonomy_marks` row the promotion pass demotes on and files the memory
 * the planner will see next time, in one call.
 *
 * The action class is never trusted from the form: it is re-derived by
 * looking `jobId`/`stepId` up in `listAutonomousActions`'s own output, the
 * same criteria that decided this pair may be marked at all. A hidden field
 * a browser could carry unmodified would still be a value this route chose
 * to believe rather than to check — and a job/step that already went through
 * a card (or does not exist) must be refused here for the same reason the
 * list never shows it: marking it would misattribute a human's own decision
 * to the assistant, and would demote a class for a step nobody let it run
 * alone.
 */
async function handleAutonomousActionMark(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: Session,
  jobId: string,
  stepId: string,
): Promise<void> {
  const form = await readFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, renderForbidden());
  }

  const note = (form.get('note') ?? '').trim();
  const actions = await listAutonomousActions({ businessId });
  const action = actions.find((candidate) => candidate.jobId === jobId && candidate.stepId === stepId);

  if (action === undefined || note === '') {
    const message =
      action === undefined
        ? 'הפעולה הזאת אינה ברשימת הפעולות העצמאיות — ייתכן שכבר טופלה.'
        : 'יש להזין נימוק.';
    return sendHtml(res, 400, renderAutonomousActions(actions, issueCsrfToken(session.sessionId), message));
  }

  await recordCorrection(
    { jobId, stepId, actionClass: action.actionClass, note, by: session.username },
    { businessId },
  );
  redirect(res, '/autonomy/actions');
}

const CARD_PATH = /^\/a\/([^/]+)$/;
const MAIL_PATH = /^\/mail\/([^/]+)$/;
const DOCUMENT_FILE_PATH = /^\/documents\/([^/]+)\/file$/;
const DECISION_PATH = /^\/a\/([^/]+)\/(approve|deny|sign)$/;
const INSTRUCT_ANSWER_PATH = /^\/instruct\/([^/]+)\/answer$/;
const INSTRUCT_CONFIRM_PATH = /^\/instruct\/([^/]+)\/confirm$/;
const AUTONOMOUS_ACTION_MARK_PATH = /^\/autonomy\/actions\/([^/]+)\/([^/]+)\/mark$/;
const OAUTH_START_PATH = /^\/oauth\/([^/]+)\/start$/;
const OAUTH_REVOKE_PATH = /^\/oauth\/([^/]+)\/revoke$/;

/** The outcome `handleDecision` records for each `DECISION_PATH` action. */
const OUTCOME_FOR_ACTION = {
  approve: 'approved',
  deny: 'denied',
  sign: 'signed',
} as const;

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  trustProxy: boolean,
  documentRoot: string | undefined,
  oauthOptions: OAuthRouteOptions,
): Promise<void> {
  const method = req.method ?? 'GET';
  const requestUrl = new URL(req.url ?? '/', 'http://dashboard.local');
  const pathname = requestUrl.pathname;

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
  if (method === 'POST' && pathname === '/login') {
    return handleLoginPost(req, res, businessId, trustProxy);
  }

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
  if (method === 'GET' && pathname === '/readings') return handleReadings(res, businessId, session);
  if (method === 'GET' && pathname === '/memory') return handleMemory(res, businessId, session);
  if (method === 'GET' && pathname === '/connections') return handleConnections(res, businessId, session);
  // The mailbox screens: list with search, invoices by supplier, one mail, and
  // the business-scoped document download they link to.
  if (method === 'GET' && pathname === '/mail') {
    return handleMailList(res, businessId, requestUrl, issueCsrfToken(session.sessionId));
  }
  if (method === 'GET' && pathname === '/mail/invoices') {
    return handleInvoices(res, businessId, requestUrl, issueCsrfToken(session.sessionId));
  }
  // Before `MAIL_PATH`, which would read "documents" as a mail id.
  if (method === 'GET' && pathname === '/mail/documents') return handleMailDocuments(res, businessId, requestUrl);
  const mailMatch = MAIL_PATH.exec(pathname);
  if (method === 'GET' && mailMatch?.[1] !== undefined) {
    const mailId = decodePathSegment(mailMatch[1]);
    return mailId === null ? notFound(res) : handleMailDetail(res, businessId, mailId);
  }
  const documentFileMatch = DOCUMENT_FILE_PATH.exec(pathname);
  if (method === 'GET' && documentFileMatch?.[1] !== undefined) {
    const documentId = decodePathSegment(documentFileMatch[1]);
    return documentId === null ? notFound(res) : handleDocumentFile(res, businessId, documentId, documentRoot);
  }
  // Connecting the business mailbox: sign the charter amendment FIRST, then
  // run the OAuth ceremony — see `mailbox-connect.ts` for why that order.
  if (method === 'GET' && pathname === '/connections/mailbox') {
    return handleMailboxStatus(res, businessId, issueCsrfToken(session.sessionId));
  }
  if (method === 'GET' && pathname === '/connections/mailbox/sign') {
    return handleMailboxSignGet(
      res,
      businessId,
      issueCsrfToken(session.sessionId),
      new URL(req.url ?? '/', 'http://dashboard.local').searchParams,
      oauthOptions.credentialKeyPath,
    );
  }
  if (method === 'POST' && pathname === '/connections/mailbox/sign') {
    return handleMailboxSignPost(res, businessId, session, await readFormBody(req), oauthOptions.credentialKeyPath);
  }
  if (method === 'POST' && pathname === '/connections/mailbox/revert') {
    return handleMailboxRevertPost(res, businessId, session, await readFormBody(req));
  }
  if (method === 'GET' && pathname === '/digest') return handleDigestGet(res, businessId, session);
  if (method === 'POST' && pathname === '/digest/settings')
    return handleDigestSettingsPost(req, res, businessId, session);
  if (method === 'GET' && pathname === '/conversation') return handleConversation(res, businessId, session);

  if (method === 'GET' && pathname === '/autonomy') return handleAutonomyGet(res, businessId, session);
  if (method === 'POST' && pathname === '/autonomy/mode')
    return handleAutonomyModePost(req, res, businessId, session);
  if (method === 'POST' && pathname === '/autonomy/updates')
    return handleAutonomyUpdatesPost(req, res, businessId, session);
  if (method === 'GET' && pathname === '/autonomy/actions')
    return handleAutonomousActionsGet(res, businessId, session);

  if (method === 'GET' && pathname === '/instruct') return handleInstructGet(res, businessId, session);
  if (method === 'POST' && pathname === '/instruct')
    return handleInstructPost(req, res, businessId, session, documentRoot);

  // The OAuth consent ceremony (oauth-routes.ts): the dashboard is the only
  // place behind the owner's session, with CSRF and loopback binding, where
  // handing a provider access to a business system belongs — the same
  // reasoning that puts "sign and approve" and erasure here (spec 5.1).
  const oauthStartMatch = OAUTH_START_PATH.exec(pathname);
  if (method === 'GET' && oauthStartMatch) {
    const raw = oauthStartMatch[1];
    if (raw !== undefined) {
      const system = decodePathSegment(raw);
      if (system === null) return sendHtml(res, 404, renderNotFound());
      return handleOAuthStart(
        res,
        businessId,
        session,
        system,
        oauthOptions,
        new URL(req.url ?? '/', 'http://dashboard.local').searchParams,
      );
    }
  }
  if (method === 'GET' && pathname === '/oauth/callback') {
    return handleOAuthCallback(req, res, businessId, session, oauthOptions);
  }
  const oauthRevokeMatch = OAUTH_REVOKE_PATH.exec(pathname);
  if (method === 'POST' && oauthRevokeMatch) {
    const raw = oauthRevokeMatch[1];
    if (raw !== undefined) {
      const system = decodePathSegment(raw);
      if (system === null) return sendHtml(res, 404, renderNotFound());
      return handleOAuthRevoke(req, res, businessId, session, system, oauthOptions);
    }
  }

  if (method === 'GET' && pathname === '/erase') return handleEraseGet(req, res, businessId, session, documentRoot);
  if (method === 'POST' && pathname === '/erase/preview') return handleErasePreview(req, res, businessId, session, documentRoot);
  if (method === 'POST' && pathname === '/erase/confirm') return handleEraseConfirm(req, res, businessId, session, documentRoot);
  if (method === 'POST' && pathname === '/erase/keep') return handleEraseKeep(req, res, businessId, session, documentRoot);

  const instructAnswerMatch = INSTRUCT_ANSWER_PATH.exec(pathname);
  if (method === 'POST' && instructAnswerMatch) {
    const jobId = instructAnswerMatch[1];
    if (jobId !== undefined) return handleInstructAnswer(req, res, businessId, session, jobId);
  }

  const instructConfirmMatch = INSTRUCT_CONFIRM_PATH.exec(pathname);
  if (method === 'POST' && instructConfirmMatch) {
    const jobId = instructConfirmMatch[1];
    if (jobId !== undefined) return handleInstructConfirm(req, res, businessId, session, jobId);
  }

  const markMatch = AUTONOMOUS_ACTION_MARK_PATH.exec(pathname);
  if (method === 'POST' && markMatch) {
    const jobId = markMatch[1];
    const stepId = markMatch[2];
    if (jobId !== undefined && stepId !== undefined) {
      return handleAutonomousActionMark(req, res, businessId, session, jobId, stepId);
    }
  }

  const cardMatch = CARD_PATH.exec(pathname);
  if (method === 'GET' && cardMatch) {
    const id = cardMatch[1];
    if (id !== undefined) return handleCard(res, businessId, session, id);
  }

  const decisionMatch = DECISION_PATH.exec(pathname);
  if (method === 'POST' && decisionMatch) {
    const id = decisionMatch[1];
    const action = decisionMatch[2];
    // The regex only ever captures one of the three keys below.
    if (id !== undefined && (action === 'approve' || action === 'deny' || action === 'sign')) {
      return handleDecision(req, res, businessId, session, id, OUTCOME_FOR_ACTION[action], documentRoot);
    }
  }

  sendHtml(res, 404, renderNotFound());
}

/**
 * Hosts that are only reachable from this machine. A positive list, never
 * "anything that is not 0.0.0.0": an address this file has not heard of is
 * one nobody has reasoned about, and the safe reading of that is "not
 * loopback".
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 block, which is what a loopback IPv4 address is.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Refuse to bind anything but loopback, unless a caller explicitly says
 * otherwise — and refuse loudly.
 *
 * This server does not terminate TLS (docs/dashboard-deployment.md), and it
 * sets `Secure` on the session cookie. Bind `0.0.0.0` and the result is
 * plaintext HTTP serving cookies a browser will refuse to send back: the
 * deployment does not break in any way that says what is wrong, it just
 * silently stops authenticating anyone, forever, while also exposing the
 * login form and every approval card to the network in the clear.
 *
 * A misconfiguration whose only symptom is "nobody can log in" is worth
 * throwing over. `DASHBOARD_HOST` used to be honoured verbatim.
 *
 * Exported so the refusal can be tested without actually opening a socket on
 * a public interface.
 */
export function assertBindableHost(host: string, allowNonLoopback: boolean): void {
  if (isLoopbackHost(host) || allowNonLoopback) return;
  throw new Error(
    `dashboard refuses to bind "${host}": it does not terminate TLS and sets Secure cookies, ` +
      'so a non-loopback bind serves the login form in the clear and silently stops ' +
      'authenticating anyone. Put a tunnel or reverse proxy in front and keep the bind on ' +
      '127.0.0.1, or set DASHBOARD_ALLOW_PUBLIC_BIND=1 if you really mean it.',
  );
}

export function createServer(options: DashboardOptions = {}): Server {
  const businessId = options.businessId ?? config.businessId;
  // Loopback only, always — see docs/dashboard-deployment.md. This server
  // does not terminate TLS; anything reachable from the internet must arrive
  // through a tunnel or reverse proxy that does, never by binding a public
  // interface here.
  const host = options.host ?? '127.0.0.1';
  assertBindableHost(host, options.allowNonLoopbackBind ?? false);

  const oauthOptions: OAuthRouteOptions = {
    credentialKeyPath: options.credentialKeyPath ?? process.env['CREDENTIAL_KEY_PATH'],
    dashboardBaseUrl:
      options.dashboardBaseUrl ?? process.env['DASHBOARD_BASE_URL'] ?? DEFAULT_DASHBOARD_BASE_URL,
    ...(options.oauthFetch !== undefined ? { fetchImpl: options.oauthFetch } : {}),
    ...(options.mailboxClientFor !== undefined ? { mailboxClientFor: options.mailboxClientFor } : {}),
  };

  const server = createHttpServer((req, res) => {
    route(req, res, businessId, options.trustProxy ?? false, options.documentRoot, oauthOptions).catch((err: unknown) => {
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
