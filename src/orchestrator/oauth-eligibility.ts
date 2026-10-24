/**
 * ONE predicate, shared by three call sites that must never be allowed to
 * drift into disagreeing about the same question: "can an OAuth grant
 * ever be written for for this charter-declared connection?"
 *
 * Before this module existed, `runtime.ts` answered it once (to decide
 * whether to register `createGoogleCalendarAdapter` for a `provider:
 * 'google'` binding) and the OAuth consent ceremony answered it NOT AT ALL:
 * `handleOAuthStart` (`src/dashboard/oauth-routes.ts`) validated nothing
 * about `system` and walked the owner to Google's consent screen for ANY
 * path segment — including `office-mail`, which the seeded charter declares
 * for `mail.send` only. Finishing that ceremony writes `provider: 'google'`
 * and a DERIVED credential ref onto the mail binding (`upsertBinding` is a
 * whole-row replace), and because `credentialRefForSystem('office-mail')`
 * collides byte-for-byte with the static SMTP secret ref the runbook
 * provisions (`OFFICE_MAIL`), every later `mail.send` resolves that ref
 * through a source that now finds BOTH a grant and a static secret and
 * correctly refuses with `AmbiguousCredentialRefError` — poisoning the mail
 * path, the one capability this system has ever proven end to end in a live
 * run, permanently (revoking the grant does not restore the static secret;
 * `oauth-token.ts`'s own docblock names that refusal as deliberate). This is
 * the final fix wave's Critical finding, item 1.
 *
 * **Two independent checks of the same rule is how they diverge — hence one
 * exported function, not two copies.** `runtime.ts` calls this to decide
 * whether to register an adapter; `handleOAuthStart` calls it to decide
 * whether to let the ceremony start at all; `views.ts`'s `renderConnections`
 * calls it to decide whether to show the "לחיבור" link in the first place. A
 * link the server would refuse is a worse experience than no link, and a
 * ceremony that accepts a system no adapter will ever serve is exactly the
 * hole item 1 closes.
 *
 * **Per-system profiles.** Eligibility is `oauthProfileFor(connection) !== null`
 * (`dashboard/oauth-profiles.ts`) AND `channel === 'api'`: the `mailbox`
 * connection serving `mail.send` (Gmail or Microsoft 365, chosen at start), or
 * any connection serving `calendar.read` (Google Calendar). It therefore does
 * NOT imply "a calendar adapter exists" -- `runtime.ts` checks `calendar.read`
 * explicitly when registering that adapter.
 */
import { oauthProfileFor } from '../dashboard/oauth-profiles.js';
import type { CharterConnection } from '../domain/connection.js';

/**
 * Whether a charter-declared connection is one the OAuth ceremony can serve.
 *
 * `undefined` (no connection declared for this system at all) is `false`,
 * never an exception — both call sites already handle "nothing declared" as
 * an ordinary case (`views.ts` renders an unauthorised row for every
 * declared connection regardless; `handleOAuthStart` refuses a system the
 * charter never named exactly the same way it refuses one the charter named
 * but gave no OAuth profile).
 *
 * Checked positively -- an OAuth profile exists AND `channel === 'api'` --
 * never as "anything that is not `office-mail`". `office-mail` is refused
 * because it has no profile (not the `mailbox` system, serves no calendar
 * tool), not because its name is special-cased.
 */
export function connectionAcceptsOAuthCeremony(connection: CharterConnection | undefined): boolean {
  if (connection === undefined) return false;
  return oauthProfileFor(connection) !== null && connection.channel === 'api';
}
