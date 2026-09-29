/**
 * The anti-forgery gate for the OAuth consent ceremony
 * (`src/dashboard/oauth-routes.ts`).
 *
 * Without a server-held `state`, anyone who can make the owner's browser
 * complete an authorisation flow can bind THEIR OWN provider account to this
 * business -- the owner clicks through what looks like an ordinary consent
 * screen and sees nothing unusual. So `state` here is:
 *   - random (256 bits, `randomBytes(32)`, base64url),
 *   - stored server-side in this table, and the callback validates against
 *     THIS ROW -- never trusting the query string for anything, including
 *     which system is being authorised (that travels on the row, in
 *     `system`, not as a query parameter the callback would otherwise have
 *     to believe);
 *   - single-use (`consumeState` marks it consumed in the SAME statement
 *     that reads it -- see that function's own docblock for why a
 *     read-then-write shape would be exploitable);
 *   - short-lived (`STATE_TTL_MS`);
 *   - bound to the session that opened it (`session_id`), so a state minted
 *     for one browser session cannot be completed by another.
 *
 * The shape mirrors two precedents already in this codebase: the approval
 * claim (`consumeApproval`, `governance/approvals.ts`) -- one `UPDATE ...
 * WHERE ... IS NULL` statement, not a read followed by a write -- and the
 * erasure flow's plan/fingerprint handshake (`POST /erase/confirm`,
 * `dashboard/server.ts`), which rebuilds server-side and compares rather
 * than trusting what the browser carried back. Same reasoning, applied to a
 * third round-trip through an untrusted client.
 */
import { randomBytes } from 'node:crypto';
import { getPool } from '../db/pool.js';
import type { Queryable } from '../db/pool.js';

/**
 * How long an unconsumed state stays valid. Long enough to actually complete
 * a consent flow on the provider's own pages (sign-in, pick an account,
 * click "allow"), short enough that a link that leaked -- a shared
 * screenshot, a browser history entry -- goes stale within the hour.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface CreateStateInput {
  businessId: string;
  system: string;
  sessionId: string;
  codeVerifier: string;
}

/**
 * Mint a fresh, single-use, session-bound state and store it server-side.
 * The caller embeds the returned value in the provider's authorisation URL
 * (`buildConsentUrl`'s `state` field); nothing about the return value itself
 * is ever trusted again -- the callback re-derives everything it needs
 * (`system`, `sessionId`, `codeVerifier`) from THIS ROW, via `consumeState`.
 */
export async function createState(
  input: CreateStateInput,
  options: { db?: Queryable } = {},
): Promise<string> {
  const db = options.db ?? getPool();
  const state = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();
  await db.query(
    `INSERT INTO oauth_states (state, business_id, system, session_id, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [state, input.businessId, input.system, input.sessionId, input.codeVerifier, expiresAt],
  );
  return state;
}

export interface ConsumedState {
  system: string;
  sessionId: string;
  codeVerifier: string;
}

/**
 * Claim a state exactly once.
 *
 * **One statement, deliberately** -- the same reason `consumeApproval`
 * (`governance/approvals.ts`) is one statement and not a read followed by a
 * write: a read-then-write here would let two concurrent callback requests
 * (a reloaded tab, a resubmitted redirect) both observe an unconsumed row
 * and both proceed, which for a single-use anti-forgery token defeats the
 * entire point of it being single-use.
 *
 * Scoped to `businessId` in the `WHERE` clause -- not merely by the caller
 * checking the returned value afterwards -- for the same reason every
 * credential and grant path in this codebase requires a mandatory,
 * undefaulted business id: an omitted or wrong business would read the claim
 * as belonging to "whatever business this table happens to have a matching
 * `state` for", which is exactly the cross-tenant read this predicate rules
 * out structurally.
 *
 * Returns `null` for a state that never existed, already expired, or was
 * already consumed -- deliberately indistinguishable from each other here.
 * The caller (the callback route) does not need to tell them apart to do the
 * right thing: refuse, and say so in words a human can read, without
 * revealing which of the three actually happened.
 */
export async function consumeState(
  state: string,
  businessId: string,
  options: { db?: Queryable } = {},
): Promise<ConsumedState | null> {
  const db = options.db ?? getPool();
  const { rows } = await db.query<{ system: string; session_id: string; code_verifier: string }>(
    `UPDATE oauth_states
        SET consumed_at = now()
      WHERE state = $1
        AND business_id = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING system, session_id, code_verifier`,
    [state, businessId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { system: row.system, sessionId: row.session_id, codeVerifier: row.code_verifier };
}
