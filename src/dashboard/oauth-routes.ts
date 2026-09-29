/**
 * The dashboard routes that turn an owner's click into a stored OAuth
 * grant: `GET /oauth/:system/start`, `GET /oauth/callback`, and
 * `POST /oauth/:system/revoke`.
 *
 * **Google only, today.** This ceremony hardcodes `provider: 'google'` and
 * one scope (`GOOGLE_CALENDAR_READONLY_SCOPE`) because that is the only
 * provider adapter this subproject wires (`orchestrator/adapters/
 * google-calendar.ts`). A second provider needs a real per-system mapping
 * here -- see spec 9, "the second provider, after the first one works live."
 *
 * **The grant write lives here, and ONLY here (besides the token service).**
 * `oauth-consent.ts` builds URLs and exchanges codes; it never imports
 * `../governance/oauth-grants.js`. A later task's source scan pins the set
 * of files that may import that module to exactly this file and
 * `../orchestrator/oauth-token.ts` (spec invariant 3) -- see that module's
 * own docblock for the full reasoning.
 *
 * **`state` is validated against the stored row, never trusted from the
 * query string -- for anything, including which system is being
 * authorised.** `consumeState` (`../governance/oauth-state.js`) is the one
 * source of truth for `system` in the callback; the query string's own
 * `state` value is looked up, never believed. Same shape `POST
 * /erase/confirm` already uses: rebuild server-side, compare a handle,
 * never trust what the browser carried back.
 *
 * **Revocation is local-first.** `revokeGrant` (the authoritative act for
 * us) runs BEFORE the best-effort attempt to also revoke at the provider --
 * the reverse would leave a window where the provider never answered and
 * the assistant still believes it has access. Same reasoning `killswitch.ts`
 * documents for `trip()` writing its state before recording it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appendAudit } from '../audit/log.js';
import { loadActiveCharter } from '../charter/store.js';
import { withTransaction } from '../db/pool.js';
import { canonicalHash } from '../util/canonical.js';
import { storedCredentials } from '../governance/credential-store.js';
import { MasterKeyError, loadMasterKey, verifyKeyState } from '../governance/master-key.js';
import { readGrantBySystem, revokeGrant, writeGrant } from '../governance/oauth-grants.js';
import { consumeState, createState } from '../governance/oauth-state.js';
import {
  GOOGLE_CLIENT_ID_REF,
  GOOGLE_CLIENT_SECRET_REF,
} from '../orchestrator/adapters/google-token-http.js';
import { loadBindings, upsertBinding } from '../orchestrator/bindings.js';
import { connectionAcceptsOAuthCeremony } from '../orchestrator/oauth-eligibility.js';
import { verifyCsrfToken } from './csrf.js';
import { escapeHtml } from './views.js';
import {
  buildConsentUrl,
  codeChallengeFor,
  createCodeVerifier,
  exchangeCode,
  fetchGoogleAccount,
} from './oauth-consent.js';

/** The one provider this ceremony authorises today. See module docblock. */
const OAUTH_PROVIDER = 'google';

/** The narrowest scope that allows the one read this subproject serves -- calendar events, read-only. Widening it is a separate decision, requiring re-consent (spec 5.3). */
const GOOGLE_CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** Google's token revocation endpoint. No client authentication required -- the token itself is the credential being revoked. */
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * The same default `buildRuntime` (`orchestrator/runtime.ts`) uses for
 * `DASHBOARD_BASE_URL` when it is unset -- kept identical so the two
 * processes agree absent configuration, rather than silently disagreeing
 * about what the dashboard's own externally-reachable address is.
 */
export const DEFAULT_DASHBOARD_BASE_URL = 'http://127.0.0.1:8787';

/** A form body this small never needs a size refusal of its own -- see `MAX_BODY_BYTES` in `server.ts` for the real limit on a payload that matters. Anything past this is simply truncated, and a truncated CSRF token fails verification the ordinary way. */
const MAX_REVOKE_BODY_BYTES = 8 * 1024;

async function readSmallFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_REVOKE_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** The minimal session shape these routes need -- structurally compatible with `server.ts`'s own `Session`, without requiring that type to be exported. */
export interface OAuthSession {
  sessionId: string;
  username: string;
}

export interface OAuthRouteOptions {
  /** Defaults to `process.env['CREDENTIAL_KEY_PATH']` when the caller passes `undefined`. */
  credentialKeyPath: string | undefined;
  /** The externally-reachable base URL the redirect_uri is built from -- see `redirectUriFor`'s own docblock. */
  dashboardBaseUrl: string;
  /** Test seam only. No production caller ever passes it. */
  fetchImpl?: typeof fetch;
}

/**
 * The redirect_uri Google is told about, and the one it must redirect back
 * to byte-for-byte. Built from the SAME base URL the dashboard already uses
 * for approval links (`DASHBOARD_BASE_URL`, `runtime.ts`) -- not from
 * whatever host/port this process happens to be bound to, which may be a
 * loopback address behind a tunnel with a different externally-reachable
 * name. Getting this wrong is the single most common installation failure
 * (spec 5.5); the readiness script prints the computed value as its own
 * line for exactly that reason.
 */
export function redirectUriFor(dashboardBaseUrl: string): string {
  return `${dashboardBaseUrl.replace(/\/+$/, '')}/oauth/callback`;
}

/**
 * Thrown when a `system` name cannot be turned into a `credential_ref`
 * injectively — see `assertValidOAuthSystemName`'s own docblock.
 */
export class UnmappableOAuthSystemNameError extends Error {}

/**
 * Legal shape for a `system` name this ceremony can turn into a
 * `credential_ref` reversibly: lowercase letters, digits and hyphens only,
 * starting with a letter — `office-mail`, `office-calendar`,
 * `supplier-a-api`, every real example in this codebase.
 *
 * **Narrower than what the charter schema allows for `system`, on
 * purpose.** `CharterConnection.system` is `z.string().min(1)` — any
 * non-empty string — because the charter's own concerns (does the system
 * exist, on which channel, serving which tools) never needed a stricter
 * shape. This ceremony does, because `-` is the ONLY character the mapping
 * below may fold into `_`: allowing `.`  or an existing `_` in the input
 * would let two DIFFERENT legal system names produce the SAME ref (final fix
 * wave, item 1c — see `credentialRefForSystem`'s own docblock for the
 * concrete collision this closes).
 */
const OAUTH_SYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertValidOAuthSystemName(system: string): void {
  if (!OAUTH_SYSTEM_NAME_PATTERN.test(system)) {
    throw new UnmappableOAuthSystemNameError(
      `שם המערכת "${system}" אינו ניתן למיפוי חד-חד-ערכי להפניית credential — ` +
        'מותרות רק אותיות לועזיות קטנות, ספרות ומקף (-), החל באות',
    );
  }
}

/**
 * A `credential_ref` this ceremony can name deterministically AND
 * INJECTIVELY from a system name, and that satisfies `CREDENTIAL_REF_PATTERN`.
 * `office-calendar` -> `OAUTH_OFFICE_CALENDAR`.
 *
 * **Namespaced under `OAUTH_`, not bare (final fix wave, item 1c).** The
 * bare mapping this function used to compute
 * (`system.toUpperCase().replace(/[^A-Z0-9_]/g, '_')`) produced `OFFICE_MAIL`
 * for `office-mail` — BYTE-IDENTICAL to the static SMTP secret ref the
 * runbook provisions under that exact name (`OFFICE_MAIL`,
 * `scripts/seed-charter.ts`). `upsertBinding` is a whole-row replace, so
 * completing this ceremony against `office-mail` rewrote `credentialRef` to
 * a value the static secret already owned, and every later `mail.send`
 * resolved a ref that existed as BOTH a grant and a static secret —
 * `AmbiguousCredentialRefError`, non-retryably, forever (see
 * `oauth-eligibility.ts`'s module docblock for the full chain). Item 1a's
 * gate stops `office-mail` specifically from reaching this function at all;
 * the `OAUTH_` prefix is what makes the collision structurally impossible
 * for every system name, including ones no gate was ever written to name.
 *
 * **Injective, not merely deterministic.** The bare mapping also collapsed
 * `office-calendar`, `office.calendar` and `office_calendar` onto the
 * identical ref — `-`, `.` and an already-present `_` all folded to `_`
 * alike — so two charter connections with genuinely distinct names could
 * silently share one `credential_ref`, colliding on migration 035's partial
 * unique index (one ref per business, across `credentials` and
 * `oauth_grants` together) and surfacing as a raw 500 AFTER this ceremony's
 * single-use `state` was already consumed. `assertValidOAuthSystemName`
 * restricts the INPUT alphabet to the one character (`-`) this function
 * folds, so two different legal inputs can never fold to the same output; a
 * system name outside that alphabet is refused, with a readable reason,
 * rather than silently mapped into a collision.
 */
function credentialRefForSystem(system: string): string {
  assertValidOAuthSystemName(system);
  return `OAUTH_${system.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The master key, read fresh for this request -- the same discipline
 * `secret.ts`'s own `loadKeyFromEnv` keeps ("read fresh ... for every
 * command that needs it"), rather than a value cached across requests that
 * a key rotation could silently outlive.
 */
async function loadKeyForRequest(credentialKeyPath: string | undefined): Promise<Buffer> {
  if (credentialKeyPath === undefined || credentialKeyPath.length === 0) {
    throw new MasterKeyError('CREDENTIAL_KEY_PATH אינו מוגדר — אין מפתח לפתוח בו את הסודות');
  }
  const key = await loadMasterKey(credentialKeyPath);
  await verifyKeyState(key);
  return key;
}

// --- Rendering. Deliberately not in `views.ts` -- Task 6 owns that file for
// the connections screen, and these are small, self-contained refusal/
// success pages this ceremony alone needs. ---------------------------------

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .error { color: #c0392b; font-weight: bold; }
</style>
</head>
<body>
${bodyHtml}
<p><a href="/">חזרה לדשבורד</a></p>
</body>
</html>`;
}

function errorBlock(message: string): string {
  return `<p class="error">${escapeHtml(message)}</p>`;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
  });
  res.end();
}

/**
 * `GET /oauth/:system/start` -- requires a session (enforced by the caller,
 * `server.ts`'s `route()`, before this is ever reached). Mints a PKCE pair
 * and a single-use `state`, stores both server-side, and redirects to
 * Google. No CSRF token: this is a plain navigation (a link, not a form
 * submit), and the worst a forged request against it can do is create an
 * unconsumed `state` row that expires on its own -- the callback still
 * requires the SAME browser session to complete Google's own consent screen
 * before anything is written.
 *
 * **Gates which `system` it will even start on (final fix wave, item 1a) --
 * two independent, readable refusals, never a 500.** Before this fix nothing
 * here validated `system` at all: it walked the owner to Google's consent
 * screen for ANY path segment, including `office-mail`, which the seeded
 * charter declares for `mail.send` only. Completing that ceremony poisoned
 * the mail path permanently -- see `oauth-eligibility.ts`'s module docblock
 * for the full chain this closes.
 *   1. The system name's own SHAPE must be one `credentialRefForSystem` can
 *      map injectively (`assertValidOAuthSystemName`) -- checked first,
 *      before any database read, because it needs none.
 *   2. The active charter must declare a connection for `system` that this
 *      ceremony (and the Google Calendar adapter it authorises) can actually
 *      serve -- `connectionAcceptsOAuthCeremony`, the SAME predicate
 *      `buildRuntime` already applies when deciding whether to register that
 *      adapter. An unreadable charter is treated exactly like no matching
 *      connection: refuse, rather than guess.
 */
export async function handleOAuthStart(
  res: ServerResponse,
  businessId: string,
  session: OAuthSession,
  system: string,
  options: OAuthRouteOptions,
): Promise<void> {
  try {
    assertValidOAuthSystemName(system);
  } catch (error) {
    return sendHtml(
      res,
      400,
      page(
        'שם מערכת לא תקין',
        errorBlock(error instanceof Error ? error.message : String(error)),
      ),
    );
  }

  let active: Awaited<ReturnType<typeof loadActiveCharter>>;
  try {
    active = await loadActiveCharter(businessId);
  } catch {
    // An unreadable charter is refused exactly like no matching connection
    // below -- this ceremony is not the place to diagnose WHY the charter
    // cannot be read; `/connections` already says so on its own screen.
    active = null;
  }
  const connection = active?.charter.connections.find((c) => c.system === system);
  if (!connectionAcceptsOAuthCeremony(connection)) {
    return sendHtml(
      res,
      400,
      page(
        'מערכת לא נתמכת',
        errorBlock(
          `המערכת "${system}" אינה מוגדרת בתקנון החתום כחיבור שתהליך ההרשאה הזה יכול לשרת — ` +
            'נדרש חיבור בערוץ API שמשרת קריאת יומן. לא בוצעה כל פעולה, ולא נפתח מסלול לספק.',
        ),
      ),
    );
  }

  let key: Buffer;
  try {
    key = await loadKeyForRequest(options.credentialKeyPath);
  } catch {
    return sendHtml(
      res,
      500,
      page(
        'שגיאת תצורה',
        errorBlock('לא ניתן להתחיל בתהליך ההרשאה: המפתח הראשי של ההתקנה אינו מוגדר או שאינו תקין.'),
      ),
    );
  }

  // Both refs, not only the client id (final fix wave, item 9). An install
  // holding one but not the other used to sail through this check, walk the
  // owner all the way to Google's consent screen, and only fail at the
  // exchange in `handleOAuthCallback` -- AFTER the state was burned, so the
  // owner has to start the whole ceremony over having learned nothing they
  // could not have been told up front.
  const credentials = storedCredentials(key);
  const [clientId, clientSecret] = await Promise.all([
    credentials.resolve(GOOGLE_CLIENT_ID_REF, businessId),
    credentials.resolve(GOOGLE_CLIENT_SECRET_REF, businessId),
  ]);
  if (clientId === null || clientSecret === null) {
    return sendHtml(
      res,
      500,
      page(
        'תצורה חסרה',
        errorBlock(
          `תצורת ה-OAuth של Google חסרה — יש להקציב ${GOOGLE_CLIENT_ID_REF} ו-${GOOGLE_CLIENT_SECRET_REF} ` +
            'במאגר הסודות לפני שאפשר להתחיל.',
        ),
      ),
    );
  }

  const codeVerifier = createCodeVerifier();
  const state = await createState({ businessId, system, sessionId: session.sessionId, codeVerifier });
  const consentUrl = buildConsentUrl({
    provider: OAUTH_PROVIDER,
    clientId: clientId.value,
    redirectUri: redirectUriFor(options.dashboardBaseUrl),
    scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
    state,
    codeChallenge: codeChallengeFor(codeVerifier),
  });
  redirect(res, consentUrl);
}

const INVALID_STATE_MESSAGE =
  'הבקשה אינה תקפה — פגה, כבר נוצלה, או לא נפתחה מהסשן הזה. יש להתחיל את תהליך ההרשאה מחדש.';

/**
 * `GET /oauth/callback` -- Google redirects here with either `error` (the
 * owner declined, or the provider refused) or `code` (success).
 *
 * `state` is consumed FIRST, before anything else is read from the query
 * string, and `system` is taken from the consumed row -- never from a
 * `system` the query string might otherwise have carried. A `consumed.
 * sessionId` mismatch is refused with the identical message an invalid
 * state gets: distinguishing them would tell a prober which half of the
 * check failed.
 */
export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: OAuthSession,
  options: OAuthRouteOptions,
): Promise<void> {
  const params = new URL(req.url ?? '/oauth/callback', 'http://dashboard.local').searchParams;
  const stateParam = params.get('state');
  if (stateParam === null) {
    return sendHtml(res, 400, page('בקשה לא תקינה', errorBlock('לבקשה חסר פרמטר state.')));
  }

  const consumed = await consumeState(stateParam, businessId);
  if (consumed === null || consumed.sessionId !== session.sessionId) {
    return sendHtml(res, 400, page('הבקשה אינה תקפה', errorBlock(INVALID_STATE_MESSAGE)));
  }

  // Trusted from here on -- the row this session actually opened, never the
  // query string.
  const system = consumed.system;

  const providerError = params.get('error');
  if (providerError !== null) {
    return sendHtml(
      res,
      200,
      page(
        'ההרשאה לא ניתנה',
        errorBlock(`הבקשה לחבר את המערכת "${system}" נדחתה, ולא בוצע דבר.`),
      ),
    );
  }

  const code = params.get('code');
  if (code === null) {
    return sendHtml(res, 400, page('בקשה לא תקינה', errorBlock('לא התקבל קוד הרשאה מהספק.')));
  }

  let key: Buffer;
  try {
    key = await loadKeyForRequest(options.credentialKeyPath);
  } catch {
    return sendHtml(
      res,
      500,
      page('שגיאת תצורה', errorBlock('לא ניתן להשלים את ההרשאה: המפתח הראשי של ההתקנה אינו מוגדר או שאינו תקין.')),
    );
  }

  const exchange = await exchangeCode({
    code,
    codeVerifier: consumed.codeVerifier,
    redirectUri: redirectUriFor(options.dashboardBaseUrl),
    credentials: storedCredentials(key),
    businessId,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  if (!exchange.ok) {
    return sendHtml(res, 400, page('ההרשאה נכשלה', errorBlock(exchange.message)));
  }

  if (exchange.refreshToken === null) {
    // access_type=offline + prompt=consent were both sent (buildConsentUrl's
    // own docblock) -- a missing refresh token here means something is
    // already wrong (a stale, already-authorised grant Google silently
    // re-approved before this ceremony asked for `prompt=consent`, most
    // likely), not a state this ceremony can complete.
    return sendHtml(
      res,
      400,
      page(
        'ההרשאה נכשלה',
        errorBlock(
          'Google לא החזירה אסימון רענון עבור החיבור הזה. אם המערכת כבר חוברה בעבר, יש לבטל אותה ולנסות שוב.',
        ),
      ),
    );
  }

  // Narrowed into its own binding: the null-check above narrows
  // `exchange.refreshToken` only in THIS scope, not inside the `withTransaction`
  // closure below, which TypeScript cannot prove runs before anything else
  // could reassign the property.
  const refreshToken: string = exchange.refreshToken;

  const account = (await fetchGoogleAccount(exchange.accessToken, options.fetchImpl)) ?? 'לא זוהה';
  const credentialRef = credentialRefForSystem(system);

  // The grant, its audit row, and the binding write are ONE transaction --
  // not three independent commits. `appendAudit` committing separately AFTER
  // `writeGrant` would leave a refresh token for the business's own Google
  // account sealed in the database with no `credential_change` row anywhere
  // if the append failed -- exactly the shape `upsertBinding`'s own docblock
  // refuses ("an append that fails must roll the write back ... which would
  // make the audit trail a mitigation in name only") and `decideAndSign`
  // refuses for the identical reason. Both provider calls (`exchangeCode`,
  // `fetchGoogleAccount`) already completed ABOVE this point, deliberately:
  // holding a pooled connection open across a network round trip is the
  // usual reason to refuse a transaction like this one, and neither call
  // needs to be inside it. `consumeState` (above) stays OUTSIDE too -- it is
  // the anti-forgery claim, and rolling it back on a downstream failure would
  // make the state reusable. So a failure here rolls the grant, audit and
  // binding back together while the state stays consumed, and the owner
  // simply restarts the ceremony -- the same trade `decideAndSign` makes for
  // a failed sign-and-approve. The success page below is rendered only after
  // this commits.
  await withTransaction(async (tx) => {
    await writeGrant(
      {
        businessId,
        system,
        provider: OAUTH_PROVIDER,
        credentialRef,
        account,
        scopes: exchange.grantedScopes,
        refreshToken,
        grantedBy: session.username,
      },
      key,
      { db: tx },
    );

    await appendAudit(
      {
        actor: 'human',
        onBehalfOf: session.username,
        kind: 'credential_change',
        // No charter decision to name a version for -- this sits beside the
        // gate, like `secret.ts`'s own `credential_change` rows and
        // `erasure.ts`'s owner-triggered actions.
        charterVersion: 'n/a',
        provenance: 'boss',
        inputHash: canonicalHash({ businessId, system, provider: OAUTH_PROVIDER, credentialRef }),
        reason:
          `oauth consent granted for system "${system}" (provider: ${OAUTH_PROVIDER}) by ${session.username}; ` +
          `scopes: ${exchange.grantedScopes.length > 0 ? exchange.grantedScopes.join(', ') : '(none reported)'}`,
      },
      { businessId, tx },
    );

    // Task 4's fix: the callback must also write the binding's `provider`,
    // not only the grant -- otherwise the owner has authorised Google with
    // no adapter ever registered for it. Existing operational fields
    // (`endpoint`, health) are preserved rather than reset, since
    // `upsertBinding` is a whole-row replace.
    const existing = (await loadBindings({ businessId, db: tx })).find((b) => b.system === system) ?? null;
    await upsertBinding(
      {
        system,
        status: 'live',
        endpoint: existing?.endpoint ?? null,
        credentialRef,
        provider: OAUTH_PROVIDER,
        lastOkAt: existing?.lastOkAt ?? null,
        lastError: existing?.lastError ?? null,
      },
      { businessId, by: session.username, db: tx },
    );
  });

  sendHtml(
    res,
    200,
    page(
      'ההרשאה הושלמה',
      `<p>החיבור למערכת "<b>${escapeHtml(system)}</b>" אושר בהצלחה, לחשבון <b>${escapeHtml(account)}</b>.</p>` +
        `<p>ההיקפים שאושרו בפועל: ${
          exchange.grantedScopes.length > 0 ? escapeHtml(exchange.grantedScopes.join(', ')) : 'לא דווח היקף'
        }.</p>` +
        `<p class="muted">שימו לב: תזמון המשימות (ה-scheduler) קורא את רשימת החיבורים פעם אחת בלבד, בעת ההפעלה שלו. ` +
        `אם הוא כבר רץ, החיבור החדש ייכנס לתוקף רק אחרי שהוא יופעל מחדש.</p>`,
    ),
  );
}

/**
 * `POST /oauth/:system/revoke` -- CSRF-protected. Marks the grant revoked
 * LOCALLY first (authoritative for us regardless of what happens next), and
 * only then attempts a best-effort revocation at the provider. The refresh
 * token is read BEFORE the local mark, because `readGrantBySystem` filters
 * `revoked_at IS NULL` -- after marking, the ordinary read path can no
 * longer see it, which is exactly the point of a soft revoke, but it means
 * the plaintext token for the provider-side attempt has to be captured
 * first and held only in this function's own memory.
 *
 * **The audit row states which of three things actually happened, never a
 * sentence that could be false.** `revokeGrant`'s own return value (whether a
 * live row actually changed) decides the local half, so "revoked locally" is
 * never written when nothing was live. The provider half distinguishes a
 * live grant the provider confirmed or refused revoking from the case where
 * the master key itself would not open -- that case is NOT "no live grant
 * was found": a live grant may well exist and remain valid at the provider,
 * and the honest thing to record is that this attempt could not check. Same
 * standard `KillSwitchAuditUnrecordedError`/`ErasureAuditUnrecordedError`
 * hold elsewhere in this codebase: say what happened, never what merely
 * looks similar.
 */
export async function handleOAuthRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  businessId: string,
  session: OAuthSession,
  system: string,
  options: OAuthRouteOptions,
): Promise<void> {
  const form = await readSmallFormBody(req);
  if (!verifyCsrfToken(session.sessionId, form.get('csrf'))) {
    return sendHtml(res, 403, page('הבקשה נדחתה', errorBlock('הטופס פג תוקף. רענן/י ונסה/י שוב.')));
  }

  let key: Buffer | null = null;
  let keyUnavailable = false;
  try {
    key = await loadKeyForRequest(options.credentialKeyPath);
  } catch {
    // The local revoke below must still proceed even without a working
    // master key -- it is authoritative for us regardless of whether we can
    // also reach the provider. See module docblock.
    key = null;
    keyUnavailable = true;
  }

  const grant = key !== null ? await readGrantBySystem(system, businessId, key) : null;

  // Local-first, and authoritative: written before any network call to the
  // provider, matching `killswitch.ts`'s `trip()` writing its state before
  // recording it, for the identical reason. `changed` is `revokeGrant`'s own
  // report of whether a live row actually existed to revoke -- used below
  // instead of assuming the call itself proves something was live.
  const changed = await revokeGrant(system, businessId, session.username);

  type ProviderOutcome = 'revoked' | 'failed' | 'no_live_grant' | 'key_unavailable';
  let providerOutcome: ProviderOutcome;
  if (keyUnavailable) {
    providerOutcome = 'key_unavailable';
  } else if (grant === null) {
    providerOutcome = 'no_live_grant';
  } else {
    providerOutcome = 'failed';
    try {
      const doFetch = options.fetchImpl ?? fetch;
      const response = await doFetch(GOOGLE_REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: grant.refreshToken }).toString(),
      });
      if (response.status >= 200 && response.status < 300) providerOutcome = 'revoked';
    } catch {
      providerOutcome = 'failed';
    }
  }

  const localNote = changed
    ? 'the grant was revoked locally'
    : 'no live grant existed locally to revoke';
  const providerNote: Record<ProviderOutcome, string> = {
    revoked: 'the provider confirmed revocation',
    failed: 'the provider-side revocation attempt failed — the local revoke is authoritative regardless',
    no_live_grant: 'no live grant was found to revoke at the provider',
    key_unavailable:
      'could not attempt provider revocation — the master key would not open, so whether access remains at the provider is unknown',
  };

  await appendAudit(
    {
      actor: 'human',
      onBehalfOf: session.username,
      kind: 'credential_change',
      charterVersion: 'n/a',
      provenance: 'boss',
      inputHash: canonicalHash({ businessId, system, action: 'revoke' }),
      reason: `oauth revoke for system "${system}" by ${session.username}: ${localNote}; ${providerNote[providerOutcome]}`,
    },
    { businessId },
  );

  // No `/connections` screen exists yet in this subproject (Task 6 builds
  // it) -- redirecting there is forward-compatible with that screen once it
  // lands, and today it is simply a 404 an owner sees for one extra click.
  redirect(res, '/connections');
}
