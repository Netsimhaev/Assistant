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
import { appendAudit } from '../audit/log.js';
import { getApproval, pendingApprovals } from '../governance/approvals.js';
import { DocumentAlreadySignedError, recordSignature } from '../governance/signatures.js';
import { applyDecision } from '../orchestrator/resume.js';
import { documentForApproval } from './document-for-approval.js';
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
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
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

async function handleCard(res: ServerResponse, businessId: string, session: Session, approvalId: string): Promise<void> {
  // Scoped by businessId in the same query that loads the row — an approval
  // belonging to another business must not be distinguishable from one that
  // does not exist at all, so both come back 404, never 403.
  const approval = await getApproval(approvalId, { businessId });
  if (!approval) return sendHtml(res, 404, renderNotFound());
  // `null` (no document behind this approval) is the ordinary case — most
  // approvals never had a document — and renderApprovalCard's sign button
  // only appears when a document is actually supplied.
  const document = await documentForApproval(approvalId, { businessId });
  sendHtml(
    res,
    200,
    renderApprovalCard({
      approval,
      csrf: issueCsrfToken(session.sessionId),
      ...(document !== null ? { document } : {}),
    }),
  );
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
  // unless a real document backs this request, re-verifies its bytes on
  // disk, and only then records the signature and its audit row. Any
  // refusal here re-renders the card exactly like the edited-payload error
  // path below — it never throws, never approves, and leaves the approval
  // `pending` so the owner can fix the file and try again.
  if (outcome === 'signed') {
    const document = await documentForApproval(approvalId, { businessId });
    if (document === null) {
      // The button that posts here would not have been rendered without a
      // document — a direct POST is a stale page or someone probing.
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          ...(note !== undefined ? { noteValue: note } : {}),
          error: 'לא נמצא מסמך המשויך לבקשה זו. לא ניתן לחתום.',
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
          ...(note !== undefined ? { noteValue: note } : {}),
          error: signRefusalReason(verifyResult),
        }),
      );
    }

    // `verifyResult.sha256` — what verification just measured — not
    // `document.sha256`: the whole point of re-hashing is to sign the bytes
    // actually on disk right now, not the row's stale claim about them.
    try {
      await recordSignature(
        {
          signatureId: `SIG-${ulid()}`,
          documentId: document.documentId,
          signedSha256: verifyResult.sha256,
          approvalId,
          signedBy: session.username,
        },
        { businessId },
      );
    } catch (err) {
      if (!(err instanceof DocumentAlreadySignedError)) throw err;
      return sendHtml(
        res,
        400,
        renderApprovalCard({
          approval,
          csrf: issueCsrfToken(session.sessionId),
          document,
          ...(note !== undefined ? { noteValue: note } : {}),
          error: 'המסמך כבר נחתם בעבר. אין צורך לחתום שוב.',
        }),
      );
    }

    await appendAudit(
      {
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
        reason:
          `${session.username} חתם על המסמך ${document.documentId} ` +
          `("${document.originalName}") כחלק מאישור ${approvalId}`,
      },
      { businessId },
    );
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

  if (!edit.ok) {
    return sendHtml(
      res,
      400,
      renderApprovalCard({
        approval,
        csrf: issueCsrfToken(session.sessionId),
        editValue: edit.raw,
        ...(note !== undefined ? { noteValue: note } : {}),
        error: 'התוכן שהוזן אינו אובייקט JSON תקין. יש להזין מבנה בסגנון { "שדה": ערך } ולנסות שוב.',
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

const CARD_PATH = /^\/a\/([^/]+)$/;
const DECISION_PATH = /^\/a\/([^/]+)\/(approve|deny|sign)$/;

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
): Promise<void> {
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

  const server = createHttpServer((req, res) => {
    route(req, res, businessId, options.trustProxy ?? false, options.documentRoot).catch((err: unknown) => {
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
