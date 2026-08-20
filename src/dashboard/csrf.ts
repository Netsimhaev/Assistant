import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Process-local secret the CSRF token is HMAC'd with.
 *
 * A token that is a pure function of the session id (e.g. `sha256(sessionId)`)
 * would be computable by anyone who ever learns the raw session id through any
 * path other than the `HttpOnly` cookie — a Referer leak, a server access log,
 * a bug in some unrelated part of the page. The cookie being `HttpOnly` closes
 * off the *common* way to read it (JavaScript on a malicious page), but it is
 * not the only way a token could leak, and a pure function of the session id
 * has nothing left to protect it once it has. Folding in a secret that never
 * leaves this process closes that gap at no real cost: even a leaked session
 * id is not enough on its own to forge the matching token, because forging it
 * also requires this secret.
 *
 * Regenerated every process start. That makes every previously-issued token
 * invalid across a restart — the affected page needs a reload before its next
 * submit, not a data loss, and a dashboard restart is already a rare, visible
 * event.
 */
const CSRF_SECRET = randomBytes(32);

/** A token bound to one session id. Anyone without the session id and the process secret cannot compute it. */
export function issueCsrfToken(sessionId: string): string {
  return createHmac('sha256', CSRF_SECRET).update(sessionId).digest('hex');
}

/**
 * Constant-time comparison against the token this session id would have been
 * issued. A plain `===` on hex strings leaks how many leading characters
 * matched through timing — the same reasoning `verifyPassword` documents in
 * `auth.ts`.
 */
export function verifyCsrfToken(sessionId: string, token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = Buffer.from(issueCsrfToken(sessionId), 'hex');
  const got = Buffer.from(token, 'hex');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
